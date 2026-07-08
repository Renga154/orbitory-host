/**
 * Phase 10 — audit derivation, sanitization, and API/WS integration.
 *
 * Injects a MemoryAuditPersistence-backed store (isolated) so we can assert on
 * exactly what is recorded, and drives the real server for GET /audit + WS.
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { AuditStore, MemoryAuditPersistence } from "../src/auditStore.js";
import {
  deriveAuditFromEnvelope,
  getAuditStore,
  recordAuthFailed,
  recordProviderStartRejected,
  recordProviderStartRequested,
  recordTokenRevoked,
  setAuditStoreForTests,
} from "../src/audit.js";
import { connect } from "./helpers/wsClient.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import type { AgentSession, AuditEvent, Envelope } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"]!;

/** No audit event may ever carry a forbidden field or substring. */
const FORBIDDEN_KEY_SUBSTRINGS = [
  "token",
  "command",
  "args",
  "env",
  "authorization",
  "privatekey",
  "private_key",
  "workingdirectory",
  "image",
];

function assertNoForbiddenFields(event: AuditEvent): void {
  const serialized = JSON.stringify(event);
  const parsed = JSON.parse(serialized) as unknown;
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        keys.push(k.toLowerCase());
        walk(val);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    }
  };
  walk(parsed);
  for (const key of keys) {
    for (const forbidden of FORBIDDEN_KEY_SUBSTRINGS) {
      assert.equal(key.includes(forbidden), false, `audit event must not contain a "${forbidden}" field (saw "${key}")`);
    }
  }
}

describe("audit: derivation is sanitized", () => {
  beforeEach(() => {
    setAuditStoreForTests(new AuditStore({ persistence: new MemoryAuditPersistence() }));
  });

  test("approval.required derives counts + risk, NOT the command or affected paths", () => {
    const envelope: Envelope<unknown> = {
      type: "approval.required",
      version: 1,
      timestamp: "2026-07-04T00:00:00.000Z",
      sessionId: "session_001",
      payload: {
        approvalId: "approval_1",
        actionType: "shell_command",
        command: "rm -rf /secret/path && echo TOKEN=sk-ant-super-secret",
        reason: { en: "risky", ja: "危険" },
        riskLevel: "high",
        affectedFiles: ["/home/user/secret/creds.env", "/etc/passwd", "/a/b"],
        recommendation: "ask",
      },
    };
    const event = deriveAuditFromEnvelope(envelope);
    assert.ok(event);
    assert.equal(event!.type, "approval.required");
    assert.equal(event!.severity, "high");
    assert.equal(event!.correlationId, "approval_1");
    assert.deepEqual(event!.details, {
      actionType: "shell_command",
      riskLevel: "high",
      affectedFileCount: 3, // count only — never the paths
      recommendation: "ask",
    });
    // The raw command + secret must not survive anywhere in the event.
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("rm -rf"), false);
    assert.equal(serialized.includes("sk-ant-super-secret"), false);
    assert.equal(serialized.includes("creds.env"), false);
    assertNoForbiddenFields(event!);
  });

  test("approval.resolved derives every outcome with safe decision metadata only", () => {
    const approved = deriveAuditFromEnvelope({
      type: "approval.resolved",
      version: 1,
      timestamp: "2026-07-04T00:00:00.000Z",
      sessionId: "session_001",
      payload: {
        approvalId: "approval_approved",
        decision: "approve",
        resolvedBy: "system",
        command: "rm -rf /secret/path && echo TOKEN=sk-ant-super-secret",
      },
    });
    assert.ok(approved);
    assert.equal(approved!.type, "approval.approved");
    assert.equal(approved!.actor, "system");
    assert.equal(approved!.correlationId, "approval_approved");
    assert.deepEqual(approved!.details, { decision: "approve", resolvedBy: "system" });
    assert.equal(JSON.stringify(approved).includes("rm -rf"), false);
    assert.equal(JSON.stringify(approved).includes("sk-ant-super-secret"), false);
    assertNoForbiddenFields(approved!);

    const timedOut = deriveAuditFromEnvelope({
      type: "approval.resolved",
      version: 1,
      timestamp: "2026-07-04T00:00:00.000Z",
      sessionId: "session_001",
      payload: { approvalId: "approval_timeout", decision: "reject", resolvedBy: "timeout" },
    });
    assert.equal(timedOut?.type, "approval.rejected");
    assert.equal(timedOut?.actor, "system");
    assert.deepEqual(timedOut?.details, { decision: "reject", resolvedBy: "timeout" });
    assertNoForbiddenFields(timedOut!);
  });

  test("session.started / completed / failed derive safe metadata only", () => {
    const started = deriveAuditFromEnvelope({
      type: "session.created", version: 1, timestamp: "t", sessionId: "s1",
      // A hostile client could put a secret in the free-form title.
      payload: { agentType: "claudeCode", title: "TOKEN=sk-ant-super-secret" },
    });
    assert.equal(started?.type, "session.started");
    assert.equal(started?.agentType, "claudeCode");
    // The free-form title is NOT copied into the audit event (safe primitives only);
    // the secret must not survive anywhere in the serialized event.
    assert.equal(started?.details, null);
    assert.equal(JSON.stringify(started).includes("sk-ant-super-secret"), false);
    assertNoForbiddenFields(started!);

    // A hostile/unknown agentType is coerced to a known type, never stored raw.
    const bogus = deriveAuditFromEnvelope({
      type: "session.created", version: 1, timestamp: "t", sessionId: "s2",
      payload: { agentType: "-----BEGIN PRIVATE KEY-----", title: "x" },
    });
    assert.equal(bogus?.agentType, "custom");
    assert.equal(JSON.stringify(bogus).includes("PRIVATE KEY"), false);

    const failed = deriveAuditFromEnvelope({
      type: "session.failed", version: 1, timestamp: "t", sessionId: "s1",
      payload: { reason: { en: "boom", ja: "失敗" }, changedFileCount: 1 },
    });
    assert.equal(failed?.type, "session.failed");
    assert.equal(failed?.severity, "warning");
    assertNoForbiddenFields(failed!);
  });

  test("non-audited envelopes derive nothing", () => {
    assert.equal(deriveAuditFromEnvelope({ type: "terminal.output", version: 1, timestamp: "t", sessionId: "s1", payload: { text: "x" } }), null);
  });
});

describe("audit: explicit hook helpers are sanitized", () => {
  beforeEach(() => {
    setAuditStoreForTests(new AuditStore({ persistence: new MemoryAuditPersistence() }));
  });

  test("provider start requested coerces a hostile agentType to a known type", () => {
    recordProviderStartRequested("demo-terminal", "-----BEGIN PRIVATE KEY-----\nMII...");
    const e = getAuditStore().recent().at(-1)!;
    assert.equal(e.type, "provider.start.requested");
    assert.equal(e.agentType, "custom", "an unknown/hostile agentType is coerced, never stored raw");
    assert.equal(JSON.stringify(e).includes("PRIVATE KEY"), false);
    assertNoForbiddenFields(e);
  });

  test("provider start rejected records the reason code only (no hostile fields)", () => {
    recordProviderStartRejected("codex-disposable", "container_engine_unavailable");
    const e = getAuditStore().recent().at(-1)!;
    assert.equal(e.type, "provider.start.rejected");
    assert.deepEqual(e.details, { reason: "container_engine_unavailable" });
    assertNoForbiddenFields(e);
  });

  test("token revoked records device id + name, never a token/hash", () => {
    recordTokenRevoked("dev_1", "iPhone");
    const e = getAuditStore().recent().at(-1)!;
    assert.equal(e.type, "pairing.token.revoked");
    assert.deepEqual(e.details, { deviceId: "dev_1", deviceName: "iPhone" });
    assertNoForbiddenFields(e);
  });

  test("auth failed records a reason code only", () => {
    recordAuthFailed("ws:unknown");
    const e = getAuditStore().recent().at(-1)!;
    assert.equal(e.type, "auth.failed");
    assert.deepEqual(e.details, { reason: "ws:unknown" });
    assertNoForbiddenFields(e);
  });
});

describe("audit: GET /audit + WS integration", () => {
  let server: TestServer;

    before(async () => {
      server = await startTestServer();
      // Isolate the audit store and seed a few events (the broadcast re-wires to it).
      setAuditStoreForTests(new AuditStore({ persistence: new MemoryAuditPersistence() }));
      recordProviderStartRejected("codex-disposable", "container_engine_unavailable");
      deriveAuditFromEnvelope({
        type: "approval.resolved",
        version: 1,
        timestamp: "t",
        sessionId: "s1",
        payload: { approvalId: "a1", decision: "approve", resolvedBy: "user" },
      });
      recordTokenRevoked("dev_1", "iPhone");
    });

  after(async () => {
    await server.close();
  });

  test("GET /audit requires a token", async () => {
    const res = await fetch(`${server.httpUrl}/audit`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("GET /audit with a valid token returns sanitized events", async () => {
    const res = await fetch(`${server.httpUrl}/audit`, {
      headers: { Authorization: `Bearer ${PAIRING_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: AuditEvent[] };
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length >= 3);
    body.events.forEach(assertNoForbiddenFields);
    // No raw token string anywhere in the response.
    assert.equal(JSON.stringify(body).includes(PAIRING_TOKEN), false);
  });

  test("GET /audit honors ?limit and ?providerId filters", async () => {
    const limited = await (
      await fetch(`${server.httpUrl}/audit?limit=1`, { headers: { Authorization: `Bearer ${PAIRING_TOKEN}` } })
    ).json() as { events: AuditEvent[] };
    assert.equal(limited.events.length, 1);

    const byProvider = await (
      await fetch(`${server.httpUrl}/audit?providerId=codex-disposable`, {
        headers: { Authorization: `Bearer ${PAIRING_TOKEN}` },
      })
    ).json() as { events: AuditEvent[] };
    assert.ok(byProvider.events.every((e) => e.providerId === "codex-disposable"));
    assert.ok(byProvider.events.length >= 1);
  });

  test("WS delivers an audit.snapshot on connect and audit.event.created live", async () => {
    const client = connect(`${server.wsUrl}/ws?token=${PAIRING_TOKEN}`);
    await client.waitForOpen();
    const snapshot = await client.waitFor((e) => e.type === "audit.snapshot");
    const events = (snapshot.payload as { events: AuditEvent[] }).events;
    assert.ok(events.length >= 3, "snapshot carries the seeded events");

    // Recording a new event broadcasts audit.event.created to the connected client.
    recordAuthFailed("ws:test");
    const created = await client.waitFor((e) => e.type === "audit.event.created");
    const event = (created.payload as { event: AuditEvent }).event;
    assert.equal(event.type, "auth.failed");
    client.close();
  });

  test("approval decisions are audited once from the actual resolved outcome, not the requested scope", async () => {
    const client = connect(`${server.wsUrl}/ws?token=${PAIRING_TOKEN}`);
    await client.waitForOpen();
    await client.waitFor((e) => e.type === "server.hello");
    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    const sessions = (snapshot.payload as { sessions: AgentSession[] }).sessions;
    const target = sessions.find((s) => s.approvalRequired && s.approvalRequest);
    assert.ok(target?.approvalRequest, "expected a seeded pending approval session");
    const approvalId = target.approvalRequest.approvalId;

    const before = getAuditStore().recent().length;
    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: target.id,
      payload: { approvalId, decision: "approve", scope: "always_this_session" },
    });

    const resolved = await client.waitFor(
      (e) =>
        e.type === "approval.resolved" &&
        e.sessionId === target.id &&
        (e.payload as { approvalId?: string }).approvalId === approvalId,
    );
    assert.equal((resolved.payload as { decision?: string }).decision, "approve");

    const newEvents = getAuditStore().recent().slice(before);
    const approvalEvents = newEvents.filter((e) => e.correlationId === approvalId);
    assert.deepEqual(
      approvalEvents.map((e) => e.type),
      ["approval.approved"],
      "one resolved approval audit event should be recorded; no requested-scope allow_similar row",
    );
    approvalEvents.forEach(assertNoForbiddenFields);

    client.close();
  });
});
