/**
 * Phase 6 — Provider Management API tests.
 *
 * Covers the sanitized provider-discovery surface: `GET /providers` (auth +
 * redaction), the `providers.snapshot` WS event (on hello + on
 * `providers.request`), and the security guarantees the descriptors exist to
 * uphold — no execution/config fields ever reach the client, disabled/
 * unavailable providers can't start, and a hostile `session.start` cannot
 * inject a command/args/image/env/workingDirectory (the host config stays
 * authoritative).
 *
 * Runs against the fixture config (tests/fixtures/test-agents.config.json) via
 * ORBITORY_AGENT_CONFIG_PATH, with the fake container engine injected — so no
 * Docker is required.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { loadProviderDescriptors, loadAgentConfigs } from "../src/agentConfig.js";
import type { HostInfo, AgentSession, ProviderDescriptor } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");
const CONFIG_PATH = process.env["ORBITORY_AGENT_CONFIG_PATH"]!;

const FORBIDDEN_SUBSTRINGS = [
  "command",
  "args",
  "env",
  "image",
  "workingdirectory",
  "cwd",
  "token",
  "secret",
  "password",
  "credential",
  "user",
  "engine",
  "config",
];
const ALLOWED_KEYS = new Set(["displayName", "riskLevel"]);

function collectKeysDeep(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeysDeep(v, acc);
  else if (typeof value === "object" && value !== null)
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeysDeep(v, acc);
    }
  return acc;
}

function assertNoSensitiveKeys(payload: unknown, label: string): void {
  for (const key of collectKeysDeep(payload)) {
    if (ALLOWED_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      assert.equal(lower.includes(forbidden), false, `${label}: leaked key "${key}" (matches "${forbidden}")`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure loader tests (no server).
// ---------------------------------------------------------------------------

describe("loadProviderDescriptors (Phase 6)", () => {
  const configs = loadAgentConfigs(CONFIG_PATH);
  const descriptors = loadProviderDescriptors(CONFIG_PATH, configs);
  const byId = new Map(descriptors.map((d) => [d.id, d]));

  test("startable entries are those in the loaded allowlist, marked enabled+startable", () => {
    const echo = byId.get("echo-success");
    assert.ok(echo, "echo-success should appear as a provider");
    assert.equal(echo.startable, true);
    assert.equal(echo.enabled, true);
    assert.equal(echo.unavailableReason, null);
    assert.equal(echo.agentType, "custom");
  });

  test("a disabled entry appears as enabled:false, startable:false, reason 'disabled'", () => {
    const disabled = byId.get("disabled-echo");
    assert.ok(disabled, "disabled-echo should appear as a provider");
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.startable, false);
    assert.equal(disabled.unavailableReason, "disabled");
  });

  test("claude-code-disabled surfaces as disabled with its host-authoritative agentType", () => {
    const cc = byId.get("claude-code-disabled");
    assert.ok(cc);
    assert.equal(cc.agentType, "claudeCode");
    assert.equal(cc.startable, false);
    assert.equal(cc.unavailableReason, "disabled");
  });

  test("a required-but-unenforceable container entry is not startable (fail-closed), reason surfaced", () => {
    // sandbox-required-container: mode container + required, but no image → it's
    // an INVALID policy (dropped at load), so it appears non-startable.
    const c = byId.get("sandbox-required-container");
    assert.ok(c, "sandbox-required-container should still appear in the provider list");
    assert.equal(c.startable, false);
    assert.notEqual(c.unavailableReason, null);
  });

  test("the Phase 16 `io` field NEVER appears in a descriptor (host-only execution detail)", () => {
    for (const d of descriptors) {
      assert.equal("io" in (d as unknown as Record<string, unknown>), false, `descriptor ${d.id} leaked "io"`);
    }
    // A stream-json entry still surfaces as a normal, sanitized descriptor.
    const stream = byId.get("claude-stream-fake");
    assert.ok(stream, "claude-stream-fake should appear as a provider");
    assert.equal(stream.startable, true);
    assert.equal(stream.agentType, "claudeCode");
  });

  test("descriptors expose NO command/args/env/image/workingDirectory/paths", () => {
    assertNoSensitiveKeys({ providers: descriptors }, "loadProviderDescriptors");
    for (const d of descriptors) {
      // Spot-check: the object literally has only the 12 sanitized keys.
      assert.deepEqual(
        Object.keys(d).sort(),
        [
          "agentType",
          "displayName",
          "enabled",
          "id",
          "networkPolicy",
          "riskLevel",
          "sandboxMode",
          "sandboxRequired",
          "sandboxSupported",
          "startable",
          "unavailableReason",
          "warnings",
        ],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// GET /providers (REST).
// ---------------------------------------------------------------------------

describe("GET /providers (Phase 6)", () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  test("requires the pairing token (401 without, 401 with wrong token)", async () => {
    const noToken = await fetch(`${server.httpUrl}/providers`);
    assert.equal(noToken.status, 401);
    const wrong = await fetch(`${server.httpUrl}/providers?token=nope`);
    assert.equal(wrong.status, 401);
  });

  test("returns sanitized descriptors with a valid token (query param and bearer header)", async () => {
    const viaQuery = await fetch(`${server.httpUrl}/providers?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    assert.equal(viaQuery.status, 200);
    const body = (await viaQuery.json()) as { providers: ProviderDescriptor[] };
    assert.ok(Array.isArray(body.providers) && body.providers.length > 0);
    assertNoSensitiveKeys(body, "GET /providers");

    const viaHeader = await fetch(`${server.httpUrl}/providers`, {
      headers: { authorization: `Bearer ${PAIRING_TOKEN}` },
    });
    assert.equal(viaHeader.status, 200);
  });
});

// ---------------------------------------------------------------------------
// providers.snapshot over WebSocket + hostile session.start.
// ---------------------------------------------------------------------------

describe("providers.snapshot + start behavior (Phase 6)", () => {
  let server: TestServer;
  let client: TestWsClient;
  let hosts: HostInfo[];

  before(async () => {
    server = await startTestServer();
    client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    await client.waitForOpen();
    await client.waitFor((e) => e.type === "server.hello");
    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    hosts = (snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] }).hosts;
  });
  after(async () => {
    client.close();
    await server.close();
  });

  test("providers.snapshot is sent on hello, sanitized", async () => {
    const snap = await client.waitFor((e) => e.type === "providers.snapshot", 3000);
    assertNoSensitiveKeys(snap.payload, "providers.snapshot (hello)");
    const providers = (snap.payload as { providers: ProviderDescriptor[] }).providers;
    assert.ok(providers.some((p) => p.id === "echo-success" && p.startable));
  });

  test("providers.request re-sends providers.snapshot", async () => {
    client.send({
      type: "providers.request",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {},
    });
    // Wait for a fresh snapshot after the request (there was already one on hello).
    const count = client.received.filter((e) => e.type === "providers.snapshot").length;
    await client.waitFor(
      () => client.received.filter((e) => e.type === "providers.snapshot").length > count,
      3000,
    );
  });

  test("a disabled provider cannot be started (fail closed)", async () => {
    client.send({
      type: "session.start",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { hostId: hosts[0]!.id, agentType: "custom", title: "start disabled", providerId: "disabled-echo" },
    });
    const next = await client.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
    assert.equal((next.payload as { code: string }).code, "invalid_payload");
  });

  test("a hostile session.start cannot inject command/args/image/env/workingDirectory — host config wins", async () => {
    client.send({
      type: "session.start",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {
        hostId: hosts[0]!.id,
        // The client tries to be Claude Code AND smuggle an arbitrary command.
        agentType: "claudeCode",
        title: "hostile start",
        providerId: "echo-success",
        command: "rm",
        args: ["-rf", "/"],
        image: "evil/image:latest",
        env: { EVIL: "1" },
        envAllowlist: ["EVIL"],
        workingDirectory: "/",
        sandbox: { mode: "none" },
      } as Record<string, unknown>,
    });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    // agentType is host-authoritative (echo-success is "custom"), NOT the
    // client-sent "claudeCode".
    assert.equal((created.payload as { agentType: string }).agentType, "custom");
    // The session runs the HOST-configured echo agent, proven by its output —
    // the injected `rm -rf /` command was never spawned.
    const out = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "hello from stdout",
      4000,
    );
    assert.ok(out);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 5000);
  });
});
