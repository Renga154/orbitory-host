import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { getAuditStore, setAuditStoreForTests } from "../src/audit.js";
import { AuditStore, MemoryAuditPersistence } from "../src/auditStore.js";
import { TerminalAgentProvider } from "../src/providers/AgentProvider.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { sessionStore } from "../src/sessionStore.js";
import type {
  HostInfo,
  AgentSession,
  ProviderDescriptor,
} from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

async function connectClient(wsUrl: string): Promise<TestWsClient> {
  const next = connect(`${wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await next.waitForOpen();
  await next.waitFor((event) => event.type === "server.hello");
  await next.waitFor((event) => event.type === "session.snapshot");
  await next.waitFor((event) => event.type === "providers.snapshot");
  return next;
}

function latestProvidersSnapshot(messages: TestWsClient["received"]): {
  catalogRevision: string;
  providers: ProviderDescriptor[];
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const envelope = messages[i];
    if (envelope?.type === "providers.snapshot") {
      const payload = envelope.payload as { catalogRevision: string; providers: ProviderDescriptor[] };
      return payload;
    }
  }
  throw new Error("providers.snapshot was not received");
}

function resetAuditStore(): void {
  setAuditStoreForTests(new AuditStore({ persistence: new MemoryAuditPersistence() }));
}

function countAuditEvents(...types: string[]): number {
  return getAuditStore()
    .recent()
    .filter((event) => types.includes(event.type)).length;
}

describe("session.launch strict contract", () => {
  let server: TestServer;
  let client: TestWsClient;
  let hosts: HostInfo[];

  before(async () => {
    server = await startTestServer();
    resetAuditStore();
    client = await connectClient(server.wsUrl);
    const snapshot = client.received.find((event) => event.type === "session.snapshot");
    assert.ok(snapshot);
    hosts = (snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] }).hosts;
  });

  after(async () => {
    client.close();
    await server.close();
  });

  function baseLaunchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const providers = latestProvidersSnapshot(client.received).providers;
    const echo = providers.find((entry) => entry.id === "echo-success");
    assert.ok(echo);
    return {
      catalogRevision: latestProvidersSnapshot(client.received).catalogRevision,
      hostId: hosts[0]!.id,
      agentType: "custom",
      title: "session-launch strict contract",
      providerId: "echo-success",
      launchProfileId: echo.launchProfiles.find((entry) => entry.id === "work")?.id ?? "work",
      modelId: echo.models.find((entry) => entry.id === "default")?.id ?? "default",
      permissionProfileId:
        echo.permissionProfiles.find((entry) => entry.isDefault)?.id ?? "host-default",
      toolsetId: echo.toolsets.find((entry) => entry.id === "none")?.id ?? "none",
      ...overrides,
    };
  }

  function countReceived(
    target: TestWsClient,
    type: string,
    requestId: string,
  ): number {
    return target.received.filter(
      (envelope) =>
        envelope.type === type &&
        (envelope.payload as { requestId?: string }).requestId === requestId,
    ).length;
  }

  test("rejects unsupported payload fields", async () => {
    client.send({
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: baseLaunchPayload({ unsupported: "field" }),
    });

    const error = await client.waitFor(
      (envelope) =>
        envelope.type === "error" &&
        (envelope.payload as { code?: string }).code === "invalid_payload" &&
        (envelope.payload as { message?: string }).message?.includes("unsupported field"),
    );
    assert.equal(error.type, "error");
  });

  test("rejects stale catalogRevision and stale control snapshots", async () => {
    client.send({
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: baseLaunchPayload({ catalogRevision: "pcat_0000000000000000" }),
    });

    const error = await client.waitFor(
      (envelope) =>
        envelope.type === "error" &&
        (envelope.payload as { code?: string }).code === "invalid_payload" &&
        (envelope.payload as { message?: string }).message?.includes("provider control catalog changed"),
    );
    assert.equal(error.type, "error");
  });

  test("accepts a valid strict session.launch request", async () => {
    const payload = baseLaunchPayload({
      title: "strict launch accepted",
    });
    client.send({
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload,
    });

    const created = await client.waitFor(
      (envelope) =>
        envelope.type === "session.created" &&
        (envelope.payload as { providerId?: string }).providerId === "echo-success",
    );
    assert.equal(created.payload["toolsetId"], "none");
    assert.equal(created.payload["providerId"], "echo-success");
    assert.equal(created.payload["launchProfileId"], payload.launchProfileId);
    assert.equal(created.payload["permissionProfileId"], payload.permissionProfileId);
    assert.equal(created.payload["modelId"], payload.modelId);
  });

  test("reuses the original session for a repeated requestId", async () => {
    const requestId = "strict_launch_idempotent_001";
    const payload = baseLaunchPayload({
      title: "strict launch is idempotent",
      requestId,
    });
    const envelope = {
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload,
    };

    client.send(envelope);
    const first = await client.waitFor(
      (candidate) =>
        candidate.type === "session.created" &&
        (candidate.payload as { requestId?: string }).requestId === requestId,
    );

    client.send({ ...envelope, timestamp: new Date().toISOString() });
    const repeated = await client.waitFor(
      (candidate) =>
        candidate.type === "session.created" &&
        (candidate.payload as { requestId?: string }).requestId === requestId,
    );

    assert.equal(repeated.sessionId, first.sessionId);
    assert.equal(repeated.payload["id"], first.payload["id"]);

    const snapshot = sessionStore.getSessionsSnapshot();
    assert.equal(snapshot.filter((session) => session.requestId === requestId).length, 1);
  });

  test("replay replies only to the requesting socket and does not duplicate launch-side effects", async () => {
    resetAuditStore();
    const observer = await connectClient(server.wsUrl);
    try {
      const requestId = "strict_launch_targeted_replay_001";
      const payload = baseLaunchPayload({
        title: "strict launch targeted replay",
        requestId,
        providerId: "echo-timeout",
      });

      client.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload,
      });

      const firstRequester = await client.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      const firstObserver = await observer.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      const launchAuditCount = countAuditEvents("provider.start.requested", "session.started");

      observer.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload,
      });

      const replayed = await observer.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(replayed.sessionId, firstRequester.sessionId);
      assert.equal(replayed.payload["id"], firstRequester.payload["id"]);
      assert.equal(firstObserver.sessionId, firstRequester.sessionId);
      assert.equal(countReceived(client, "session.created", requestId), 1);
      assert.equal(countReceived(observer, "session.created", requestId), 2);
      assert.equal(
        countAuditEvents("provider.start.requested", "session.started"),
        launchAuditCount,
      );
    } finally {
      observer.close();
    }
  });

  test("rejects requestId reuse with different launch inputs and echoes the id", async () => {
    const requestId = "strict_launch_conflict_001";
    const firstPayload = baseLaunchPayload({
      title: "strict launch original inputs",
      requestId,
    });
    client.send({
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: firstPayload,
    });
    await client.waitFor(
      (candidate) =>
        candidate.type === "session.created" &&
        (candidate.payload as { requestId?: string }).requestId === requestId,
    );

    client.send({
      type: "session.launch",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { ...firstPayload, title: "strict launch changed inputs" },
    });
    const error = await client.waitFor(
      (candidate) =>
        candidate.type === "error" &&
        (candidate.payload as { code?: string }).code === "idempotency_conflict",
    );

    assert.equal(error.payload["requestId"], requestId);
    assert.equal(error.payload["recoverable"], false);
    const snapshot = sessionStore.getSessionsSnapshot();
    assert.equal(snapshot.filter((session) => session.requestId === requestId).length, 1);
  });

  test("correlated requestId conflicts stay on the requesting socket and do not duplicate launch audit", async () => {
    resetAuditStore();
    const observer = await connectClient(server.wsUrl);
    try {
      const requestId = "strict_launch_targeted_conflict_001";
      const firstPayload = baseLaunchPayload({
        title: "strict launch targeted conflict",
        requestId,
        providerId: "echo-timeout",
      });
      client.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: firstPayload,
      });
      await client.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      await observer.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      const launchAuditCount = countAuditEvents("provider.start.requested", "session.started");

      observer.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: { ...firstPayload, title: "strict launch targeted conflict changed" },
      });
      const error = await observer.waitFor(
        (candidate) =>
          candidate.type === "error" &&
          (candidate.payload as { code?: string; requestId?: string }).code ===
            "idempotency_conflict" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(error.payload["recoverable"], false);
      assert.equal(countReceived(client, "error", requestId), 0);
      assert.equal(countReceived(observer, "error", requestId), 1);
      assert.equal(
        countAuditEvents("provider.start.requested", "session.started"),
        launchAuditCount,
      );
    } finally {
      observer.close();
    }
  });

  test("provider construction failure does not persist the session or requestId and fails closed", async () => {
    resetAuditStore();
    const requestId = "strict_launch_provider_ctor_failure_001";
    const originalForNewSession = TerminalAgentProvider.forNewSession;
    TerminalAgentProvider.forNewSession = (() => {
      throw new Error("injected provider construction failure");
    }) as typeof TerminalAgentProvider.forNewSession;

    try {
      client.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: baseLaunchPayload({
          title: "strict launch provider ctor failure",
          requestId,
          providerId: "echo-success",
        }),
      });

      const failed = await client.waitFor(
        (candidate) =>
          candidate.type === "error" &&
          (candidate.payload as { code?: string; requestId?: string }).code === "internal_error" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );

      assert.equal(failed.payload["recoverable"], false);
      assert.equal(
        sessionStore.getSessionsSnapshot().filter((session) => session.requestId === requestId).length,
        0,
      );

      TerminalAgentProvider.forNewSession = originalForNewSession;
      client.send({
        type: "session.launch",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: baseLaunchPayload({
          title: "strict launch provider ctor retry",
          requestId,
          providerId: "echo-success",
        }),
      });

      const created = await client.waitFor(
        (candidate) =>
          candidate.type === "session.created" &&
          (candidate.payload as { requestId?: string }).requestId === requestId,
      );
      assert.equal(created.payload["providerId"], "echo-success");
      assert.equal(
        sessionStore.getSessionsSnapshot().filter((session) => session.requestId === requestId).length,
        1,
      );
    } finally {
      TerminalAgentProvider.forNewSession = originalForNewSession;
    }
  });
});
