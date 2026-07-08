/**
 * Tests for post-handshake WebSocket behavior: `chat.message`,
 * `approval.decision` (against the seeded approval session), and error paths
 * (section 7 of docs/protocol.md).
 *
 * The full scripted mock session lifecycle and the `scope:
 * "always_this_session"` approval path both call `session.start`, which
 * rotates through a fixed scenario sequence (`completes, completes, stuck,
 * completes, failed` — see `NEW_SESSION_SCENARIOS` in
 * `src/sessionStore.ts`) via a module-level counter. Since "stuck" and
 * "failed" scenarios never reach `approval.required`, those two tests live
 * in `tests/session-lifecycle.test.ts` instead, in a controlled order, so
 * this file never calls `session.start` and can't perturb that counter.
 *
 * Known test-isolation note: `sessionStore` (src/sessionStore.ts) is a
 * module-level singleton, seeded once per process. Node's test runner runs
 * each test *file* in its own child process by default, so this file's
 * `sessionStore` state is independent of other test files', but tests
 * *within* this file share one seeded store across the whole file. Tests
 * below therefore avoid depending on an exact total session count and
 * instead look up sessions structurally (e.g. "the seeded session that has
 * approvalRequired: true").
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import type { AgentSession, HostInfo } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function authedClient(): Promise<{
  client: TestWsClient;
  hosts: HostInfo[];
  sessions: AgentSession[];
}> {
  const client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await client.waitForOpen();
  await client.waitFor((e) => e.type === "server.hello");
  const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
  const payload = snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] };
  return { client, hosts: payload.hosts, sessions: payload.sessions };
}

describe("chat.message", () => {
  test("sending a chat message produces session.updated and shows up via GET /sessions", async () => {
    const { client, sessions } = await authedClient();
    // Pick any non-terminal seeded session so a reply gets scheduled too
    // (terminal sessions still accept the message but this keeps behavior
    // consistent across whichever session we grab).
    const target =
      sessions.find((s) => s.status !== "completed" && s.status !== "failed") ?? sessions[0]!;
    assert.ok(target, "expected at least one seeded session");

    const messageText = `Test message ${Date.now()}`;

    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: target.id,
      payload: { text: messageText },
    });

    const updated = await client.waitFor(
      (e) => e.type === "session.updated" && e.sessionId === target.id,
    );
    assert.equal(updated.sessionId, target.id);

    const reply = await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === target.id &&
        (e.payload as { role?: string; text?: string }).role === "assistant",
    );
    assert.equal(
      (reply.payload as { text: string }).text,
      "Sure — I'll make sure the test suite covers that before wrapping up.",
    );

    const res = await fetch(`${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: AgentSession[] };
    const refreshed = body.sessions.find((s) => s.id === target.id);
    assert.ok(refreshed, "session should still exist after chat.message");
    assert.ok(
      refreshed.messages.some((m) => m.role === "user" && m.text === messageText),
      "expected the new user message to appear in the session's messages array",
    );
    assert.ok(
      refreshed.messages.some((m) => m.role === "assistant" && m.text === (reply.payload as { text: string }).text),
      "expected the assistant reply to appear in the session's messages array",
    );

    client.close();
  });
});

describe("approval.decision", () => {
  test("approve with scope 'once' resolves the pending approval", async () => {
    const { client, sessions } = await authedClient();
    const target = sessions.find((s) => s.approvalRequired && s.approvalRequest);
    assert.ok(target?.approvalRequest, "expected a seeded session with a pending approval");
    const approvalId = target.approvalRequest.approvalId;

    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: target.id,
      payload: { approvalId, decision: "approve", scope: "once" },
    });

    const resolved = await client.waitFor((e) => e.type === "approval.resolved");
    const payload = resolved.payload as { approvalId: string; decision: string; resolvedBy: string };
    assert.equal(payload.approvalId, approvalId);
    assert.equal(payload.decision, "approve");
    assert.equal(typeof payload.resolvedBy, "string");

    client.close();
  });

  // The `scope: "always_this_session"` path and the full scripted mock
  // lifecycle both require starting a brand-new session via `session.start`
  // and driving it to `approval.required`, which depends on which scripted
  // scenario the mock rotation assigns (see NEW_SESSION_SCENARIOS in
  // src/sessionStore.ts — "stuck" and "failed" scenarios never reach
  // approval.required). Both live in tests/session-lifecycle.test.ts, which
  // owns that rotation for its whole file so behavior stays deterministic.
});

describe("error paths", () => {
  test("malformed JSON -> recoverable error per protocol, socket stays open", async () => {
    const { client } = await authedClient();

    client.sendRaw("{not valid json");

    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    const payload = errorEnvelope.payload as { code: string; recoverable: boolean };
    assert.equal(payload.code, "invalid_payload");
    // docs/protocol.md section 7: invalid_payload -> recoverable: false.
    assert.equal(payload.recoverable, false);

    assert.equal(client.socket.readyState, client.socket.OPEN, "socket must stay open after a malformed message");

    client.close();
  });

  test("unknown event type -> error envelope, socket stays open", async () => {
    const { client } = await authedClient();

    client.send({
      type: "totally.unknown.event",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {},
    });

    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    const payload = errorEnvelope.payload as { code: string; recoverable: boolean };
    assert.equal(payload.code, "unknown_event_type");
    assert.equal(typeof payload.recoverable, "boolean");

    assert.equal(client.socket.readyState, client.socket.OPEN, "socket must stay open after an unknown event type");

    client.close();
  });

  test("approval.decision with a bogus approvalId -> error with code approval_not_found", async () => {
    const { client, sessions } = await authedClient();
    const anySession = sessions[0]!;

    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: anySession.id,
      payload: { approvalId: "approval_does_not_exist_9999", decision: "approve", scope: "once" },
    });

    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    const payload = errorEnvelope.payload as { code: string };
    assert.equal(payload.code, "approval_not_found");

    assert.equal(client.socket.readyState, client.socket.OPEN);

    client.close();
  });
});
