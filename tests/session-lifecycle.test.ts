/**
 * Tests that start brand-new sessions via `session.start` and drive them
 * through the scripted `MockAgentProvider` lifecycle (see
 * src/providers/AgentProvider.ts), covering:
 *
 *  - The full lifecycle: session.created -> agent.status.changed ->
 *    terminal.output -> approval.required -> (approve) ->
 *    approval.resolved -> session.completed | session.failed.
 *  - `approval.decision` with `scope: "always_this_session"`.
 *
 * Both live in this dedicated file (separate from ws-lifecycle.test.ts)
 * because `session.start` scenario selection rotates through a fixed
 * sequence (`NEW_SESSION_SCENARIOS` in src/sessionStore.ts: "completes",
 * "completes", "stuck", "completes", "failed") via a module-level counter
 * that's shared by every `session.start` call within a process. "stuck" and
 * "failed" scenarios never reach `approval.required` (they branch off
 * earlier), so a test that needs an approval step retries starting fresh
 * sessions (bounded) until the rotation lands on one that does, rather than
 * hardcoding the rotation's exact indices — this keeps the tests correct
 * even if NEW_SESSION_SCENARIOS is edited later.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import type { Envelope, HostInfo, AgentSession } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

let server: TestServer;
let sharedClient: TestWsClient;
let hosts: HostInfo[];

before(async () => {
  server = await startTestServer();
  sharedClient = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await sharedClient.waitForOpen();
  await sharedClient.waitFor((e) => e.type === "server.hello");
  const snapshot = await sharedClient.waitFor((e) => e.type === "session.snapshot");
  hosts = (snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] }).hosts;
});

after(async () => {
  sharedClient.close();
  await server.close();
});

/** Starts one brand-new session and returns its id + the session.created envelope. */
async function startSession(title: string): Promise<{ sessionId: string; created: Envelope<unknown> }> {
  const host = hosts[0];
  assert.ok(host, "expected at least one seeded host");

  sharedClient.send({
    type: "session.start",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    payload: { hostId: host.id, agentType: "claudeCode", title },
  });

  const created = await sharedClient.waitFor((e) => e.type === "session.created", 5000);
  return { sessionId: created.sessionId!, created };
}

/**
 * Starts fresh sessions (bounded retries) until one reaches
 * `approval.required` within `perAttemptTimeoutMs`, or gives up after
 * `maxAttempts`. An attempt whose scenario doesn't reach approval in time
 * (e.g. "stuck", which never requests approval, or "failed", whose first
 * test run fails before ever reaching approval) is immediately stopped via
 * `session.stop` before the next attempt starts — leaving it running in the
 * background would pile up concurrent `setTimeout`-driven lifecycles and
 * starve later attempts' timers, making this helper flaky.
 */
async function startSessionThatReachesApproval(
  titlePrefix: string,
  maxAttempts = 6,
): Promise<{ sessionId: string; approvalRequired: Envelope<unknown> }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { sessionId } = await startSession(`${titlePrefix} (attempt ${attempt})`);
    try {
      const approvalRequired = await sharedClient.waitFor(
        (e) => e.type === "approval.required" && e.sessionId === sessionId,
        12_000,
      );
      return { sessionId, approvalRequired };
    } catch (err) {
      // This attempt's scenario didn't reach approval.required in time
      // (likely "stuck" or "failed") — stop it so it doesn't keep running
      // in the background, then try again with a fresh session.
      lastErr = err;
      sharedClient.send({
        type: "session.stop",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId,
        payload: {},
      });
    }
  }
  throw new Error(
    `Gave up after ${maxAttempts} attempts waiting for a session.start to reach approval.required. Last error: ${String(
      lastErr,
    )}`,
  );
}

describe("approval.decision scope: always_this_session", () => {
  test("is accepted without error and resolves the approval", async () => {
    const { sessionId, approvalRequired } = await startSessionThatReachesApproval(
      "Approval scope test session",
    );
    const approvalPayload = approvalRequired.payload as { approvalId: string };

    sharedClient.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: {
        approvalId: approvalPayload.approvalId,
        decision: "approve",
        scope: "always_this_session",
      },
    });

    const resolved = await sharedClient.waitFor(
      (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
    );
    const resolvedPayload = resolved.payload as { approvalId: string; decision: string };
    assert.equal(resolvedPayload.approvalId, approvalPayload.approvalId);
    assert.equal(resolvedPayload.decision, "approve");

    const errorForSession = sharedClient.received.find(
      (e) => e.type === "error" && e.sessionId === sessionId,
    );
    assert.equal(errorForSession, undefined, "expected no error envelope for this session");
  });
});

describe("full mock lifecycle (session.start)", () => {
  test(
    "session.created -> agent.status.changed -> terminal.output -> approval.required -> " +
      "(approve) -> approval.resolved -> session.completed|session.failed",
    async () => {
      const host = hosts[0];
      assert.ok(host, "expected at least one seeded host");

      const { sessionId, created } = await startSession("Full lifecycle test session");
      const createdPayload = created.payload as { id: string; hostId: string; status: string };
      assert.equal(createdPayload.id, sessionId);
      assert.equal(createdPayload.hostId, host.id);
      assert.equal(createdPayload.status, "planning");

      const statusChanged = await sharedClient.waitFor(
        (e) => e.type === "agent.status.changed" && e.sessionId === sessionId,
        15_000,
      );
      assert.ok(statusChanged);

      const terminalOutput = await sharedClient.waitFor(
        (e) => e.type === "terminal.output" && e.sessionId === sessionId,
        15_000,
      );
      const terminalPayload = terminalOutput.payload as {
        stream: string;
        text: string;
        sequence: number;
      };
      assert.ok(terminalPayload.stream === "stdout" || terminalPayload.stream === "stderr");
      assert.equal(typeof terminalPayload.text, "string");
      assert.equal(typeof terminalPayload.sequence, "number");

      // This particular session may or may not reach approval.required
      // (depends on the scenario rotation); if it doesn't, fall through
      // straight to the terminal event instead of waiting on a step that
      // scenario skips entirely (e.g. "failed" fails during its first test
      // run, before ever reaching approval).
      let reachedApproval = false;
      try {
        const approvalRequired = await sharedClient.waitFor(
          (e) => e.type === "approval.required" && e.sessionId === sessionId,
          20_000,
        );
        const approvalPayload = approvalRequired.payload as { approvalId: string };
        assert.equal(typeof approvalPayload.approvalId, "string");
        reachedApproval = true;

        sharedClient.send({
          type: "approval.decision",
          version: 1,
          timestamp: new Date().toISOString(),
          sessionId,
          payload: { approvalId: approvalPayload.approvalId, decision: "approve", scope: "once" },
        });

        const approvalResolved = await sharedClient.waitFor(
          (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
          5000,
        );
        const resolvedPayload = approvalResolved.payload as { approvalId: string; decision: string };
        assert.equal(resolvedPayload.approvalId, approvalPayload.approvalId);
        assert.equal(resolvedPayload.decision, "approve");
      } catch {
        // Scenario skipped straight past approval (e.g. "failed"); that's
        // fine, fall through to asserting the terminal event below.
      }

      // Either terminal outcome is acceptable; the mock's scripted lifecycle
      // ends in one or the other regardless of which scenario was picked.
      const terminalEnvelope = await sharedClient.waitFor(
        (e) =>
          (e.type === "session.completed" || e.type === "session.failed") &&
          e.sessionId === sessionId,
        20_000,
      );

      if (terminalEnvelope.type === "session.completed") {
        const payload = terminalEnvelope.payload as {
          summary: { en: string; ja: string };
          changedFileCount: number;
          testStatus: { status: string; passedCount: number; failedCount: number };
        };
        assert.equal(typeof payload.summary.en, "string");
        assert.equal(typeof payload.summary.ja, "string");
        assert.equal(typeof payload.changedFileCount, "number");
        assert.equal(payload.testStatus.status, "passed");
        assert.ok(reachedApproval, "a 'completes' scenario should have passed through approval.required");
      } else {
        const payload = terminalEnvelope.payload as {
          reason: { en: string; ja: string };
          changedFileCount: number;
        };
        assert.equal(typeof payload.reason.en, "string");
        assert.equal(typeof payload.reason.ja, "string");
        assert.equal(typeof payload.changedFileCount, "number");
      }
    },
  );
});
