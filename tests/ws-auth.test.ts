/**
 * Tests for the `/ws` WebSocket authentication handshake, per
 * docs/protocol.md sections 2 and 3: query-param token, first-`client.hello`
 * token, invalid token, and the handshake timeout.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect } from "./helpers/wsClient.js";
import { setPairedDeviceStoreForTests } from "../src/auth.js";
import { MemoryPersistence, PairedDeviceStore } from "../src/pairedDevices.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe("WebSocket auth: invalid token", () => {
  test("wrong token via query param -> immediate error envelope + socket close", async () => {
    const client = connect(`${server.wsUrl}/ws?token=totally-wrong-token`);
    await client.waitForOpen();

    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    assert.equal(errorEnvelope.sessionId, null);
    const payload = errorEnvelope.payload as { code: string; message: string; recoverable: boolean };
    assert.equal(payload.code, "unauthorized");
    assert.equal(payload.recoverable, false);
    assert.equal(typeof payload.message, "string");

    const closeInfo = await client.waitForClose();
    assert.equal(closeInfo.code, 4401);
    assert.equal(closeInfo.reason, "unauthorized");
  });
});

describe("WebSocket auth: successful handshake", () => {
  test("client commands are handled immediately while the project catalog is still loading", async () => {
    let snapshotCalls = 0;
    let releaseCatalog: ((value: { projects: []; resumableSessions: [] }) => void) | undefined;
    const delayedCatalog = new Promise<{ projects: []; resumableSessions: [] }>((resolve) => {
      releaseCatalog = resolve;
    });
    const isolatedServer = await startTestServer({
      projectCatalog: {
        snapshot: () => {
          snapshotCalls += 1;
          return delayedCatalog;
        },
      },
    });
    const client = connect(
      `${isolatedServer.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`,
    );

    try {
      await client.waitForOpen();
      await client.waitFor((e) => e.type === "server.hello");
      await client.waitFor((e) => e.type === "providers.snapshot");
      assert.equal(snapshotCalls, 1, "the injected delayed catalog must own this handshake");

      client.send({
        type: "providers.request",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: {},
      });

      await client.waitFor((e) => e.type === "providers.snapshot", 500);
    } finally {
      releaseCatalog?.({ projects: [], resumableSessions: [] });
      client.close();
      await isolatedServer.close();
    }
  });

  test("a saved profile reconnects after the 10-minute pairing window", async () => {
    let clock = new Date("2026-07-04T00:00:00.000Z");
    const deviceStore = new PairedDeviceStore({
      persistence: new MemoryPersistence(),
      now: () => clock,
      deviceTtlSeconds: 30 * 24 * 60 * 60,
    });
    const { rawToken } = deviceStore.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    setPairedDeviceStoreForTests(deviceStore);

    const first = connect(`${server.wsUrl}/ws`);
    await first.waitForOpen();
    first.send({
      type: "client.hello",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { token: rawToken, clientId: "ios-profile-1" },
    });
    await first.waitFor((e) => e.type === "server.hello");
    first.close();
    await first.waitForClose();

    clock = new Date("2026-07-04T00:15:00.000Z");
    const reconnect = connect(`${server.wsUrl}/ws`);
    await reconnect.waitForOpen();
    reconnect.send({
      type: "client.hello",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { token: rawToken, clientId: "ios-profile-1" },
    });
    await reconnect.waitFor((e) => e.type === "server.hello");
    reconnect.close();
    await reconnect.waitForClose();
  });

  test("correct token via query param -> server.hello then session.snapshot in order", async () => {
    const client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    await client.waitForOpen();

    const hello = await client.waitFor((e) => e.type === "server.hello");
    assert.equal(hello.sessionId, null);
    const helloPayload = hello.payload as {
      serverName: string;
      serverVersion: string;
      protocolVersion: number;
      hostId: string;
      capabilities: string[];
    };
    assert.equal(helloPayload.serverName, "orbitory-host-agent");
    assert.equal(typeof helloPayload.serverVersion, "string");
    assert.equal(helloPayload.protocolVersion, 1);
    assert.equal(typeof helloPayload.hostId, "string");
    assert.ok(Array.isArray(helloPayload.capabilities));

    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    assert.equal(snapshot.sessionId, null);
    const snapshotPayload = snapshot.payload as { hosts: unknown[]; sessions: unknown[] };
    assert.ok(Array.isArray(snapshotPayload.hosts));
    assert.ok(Array.isArray(snapshotPayload.sessions));

    // Confirm ordering: server.hello must have been received strictly before
    // session.snapshot in the raw received buffer.
    const helloIndex = client.received.findIndex((e) => e.type === "server.hello");
    const snapshotIndex = client.received.findIndex((e) => e.type === "session.snapshot");
    assert.ok(helloIndex >= 0 && snapshotIndex >= 0);
    assert.ok(helloIndex < snapshotIndex, "server.hello must arrive before session.snapshot");

    client.close();
    await client.waitForClose();
  });

  test("correct token via first client.hello message (no query param) -> authenticates successfully", async () => {
    const client = connect(`${server.wsUrl}/ws`);
    await client.waitForOpen();

    client.send({
      type: "client.hello",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { token: PAIRING_TOKEN },
    });

    const hello = await client.waitFor((e) => e.type === "server.hello");
    assert.equal(hello.sessionId, null);

    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    assert.equal(snapshot.sessionId, null);

    client.close();
    await client.waitForClose();
  });
});

describe("WebSocket auth: handshake timeout", () => {
  test("no token and no follow-up client.hello within the timeout -> error + close", async () => {
    const client = connect(`${server.wsUrl}/ws`);
    await client.waitForOpen();
    // Deliberately do not send anything. The server's handshake timeout is
    // HELLO_TIMEOUT_MS (src/config.ts) — 5s in production, shortened via
    // ORBITORY_HELLO_TIMEOUT_MS in package.json's "test" script so this
    // test doesn't have to wait out the full production window. Wait it
    // out with generous margin either way.
    const configuredMs = Number(process.env["ORBITORY_HELLO_TIMEOUT_MS"]) || 5_000;
    const errorEnvelope = await client.waitFor((e) => e.type === "error", configuredMs + 3_000);
    assert.equal(errorEnvelope.sessionId, null);
    const payload = errorEnvelope.payload as { code: string; recoverable: boolean };
    // docs/protocol.md section 7 defines a distinct "handshake_timeout" code
    // for this case (no valid client.hello arrived at all), separate from
    // "unauthorized" (a hello arrived but the token was missing/wrong).
    // src/ws.ts's resolveToken() now distinguishes the two explicitly.
    assert.equal(payload.code, "handshake_timeout");
    assert.equal(payload.recoverable, false);

    const closeInfo = await client.waitForClose();
    assert.equal(closeInfo.code, 4401);
    assert.equal(closeInfo.reason, "unauthorized");
  });
});
