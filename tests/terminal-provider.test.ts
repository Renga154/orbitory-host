/**
 * Tests for `TerminalAgentProvider` (Alpha), covering:
 *  - The pure `parseTerminalLine` / `splitLines` marker parser (no process
 *    involved).
 *  - `session.start` with a `providerId` that matches an enabled,
 *    host-configured terminal agent (see
 *    tests/fixtures/test-agents.config.json, loaded via
 *    ORBITORY_AGENT_CONFIG_PATH in package.json's "test" script) vs. one
 *    that's unconfigured or disabled.
 *  - stdout/stderr streaming, exit-code -> session.completed/session.failed,
 *    session.stop, and chat.message delivered verbatim to the child's
 *    stdin rather than executed as a shell command.
 *
 * The fixture config's `echo-success` / `echo-failure` / `disabled-echo`
 * entries all point at tests/fixtures/echo-agent.js — a minimal,
 * deterministic process (not the polished product demo at
 * scripts/demo-agent.js) built specifically to give these tests precise,
 * fast control over stdout/stderr/exit-code/stdin-echo behavior.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { parseTerminalLine, splitLines } from "../src/providers/AgentProvider.js";
import { sandboxExecAvailable } from "../src/sandbox.js";
import type { HostInfo, AgentSession, TestResult } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

// ---------------------------------------------------------------------------
// Pure parser tests — no server, no process.
// ---------------------------------------------------------------------------

describe("parseTerminalLine", () => {
  test("STATUS marker with valid status + summary", () => {
    const line = '[[STATUS]] {"status":"testing","summary":{"en":"Running tests.","ja":"テスト実行中。"}}';
    const parsed = parseTerminalLine(line);
    assert.equal(parsed.kind, "status");
    assert.deepEqual(parsed, {
      kind: "status",
      status: "testing",
      summary: { en: "Running tests.", ja: "テスト実行中。" },
    });
  });

  test("STATUS marker with an unrecognized status falls back to plain", () => {
    const line = '[[STATUS]] {"status":"not_a_real_status","summary":{"en":"x","ja":"y"}}';
    assert.deepEqual(parseTerminalLine(line), { kind: "plain" });
  });

  test("SUMMARY marker", () => {
    const line = '[[SUMMARY]] {"en":"Doing a thing.","ja":"何かをしています。"}';
    assert.deepEqual(parseTerminalLine(line), {
      kind: "summary",
      summary: { en: "Doing a thing.", ja: "何かをしています。" },
    });
  });

  test("TESTS_STARTED marker", () => {
    const line = '[[TESTS_STARTED]] {"summary":{"en":"Running...","ja":"実行中..."}}';
    const parsed = parseTerminalLine(line);
    assert.equal(parsed.kind, "testsStarted");
  });

  test("TESTS_FINISHED marker with a full TestResult", () => {
    const line =
      '[[TESTS_FINISHED]] {"status":"passed","passedCount":5,"failedCount":0,"durationSeconds":2,"summary":{"en":"5 passed","ja":"5件合格"}}';
    const parsed = parseTerminalLine(line);
    assert.equal(parsed.kind, "testsFinished");
    if (parsed.kind === "testsFinished") {
      const result: TestResult = parsed.result;
      assert.equal(result.status, "passed");
      assert.equal(result.passedCount, 5);
      assert.equal(result.failedCount, 0);
    }
  });

  test("malformed JSON after a marker falls back to plain", () => {
    assert.deepEqual(parseTerminalLine("[[STATUS]] { not valid json"), { kind: "plain" });
  });

  test("unrecognized [[...]]-looking prefix falls back to plain (not swallowed)", () => {
    assert.deepEqual(parseTerminalLine("[[SOMETHING_ELSE]] whatever"), { kind: "plain" });
  });

  test("an ordinary line is plain", () => {
    assert.deepEqual(parseTerminalLine("$ npm test"), { kind: "plain" });
  });
});

describe("splitLines", () => {
  test("splits complete lines and holds back a trailing partial line", () => {
    const first = splitLines("", "line one\nline two\npartial-thre");
    assert.deepEqual(first.lines, ["line one", "line two"]);
    assert.equal(first.remainder, "partial-thre");

    const second = splitLines(first.remainder, "e\nline four\n");
    assert.deepEqual(second.lines, ["partial-three", "line four"]);
    assert.equal(second.remainder, "");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real server, real spawned processes.
// ---------------------------------------------------------------------------

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

/** Sends `session.start` with the given `providerId` and returns the raw envelope. */
function sendStart(providerId: string | undefined, title: string): void {
  const host = hosts[0];
  assert.ok(host, "expected at least one seeded host");
  sharedClient.send({
    type: "session.start",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    payload: { hostId: host.id, agentType: "custom", title, providerId },
  });
}

describe("session.start with providerId: allowlist enforcement", () => {
  test("unconfigured providerId is rejected with an error, no session is created", async () => {
    sendStart("this-id-does-not-exist-in-any-config", "Should be rejected");
    const next = await sharedClient.waitFor(
      (e) => e.type === "error" || e.type === "session.created",
      3000,
    );
    assert.equal(next.type, "error");
    const payload = next.payload as { code: string; recoverable: boolean };
    assert.equal(payload.code, "invalid_payload");
    assert.equal(payload.recoverable, false);
  });

  test("a disabled providerId is rejected the same way as an unconfigured one", async () => {
    sendStart("disabled-echo", "Should be rejected (disabled)");
    const next = await sharedClient.waitFor(
      (e) => e.type === "error" || e.type === "session.created",
      3000,
    );
    assert.equal(next.type, "error");
    const payload = next.payload as { code: string };
    assert.equal(payload.code, "invalid_payload");
  });

  test("an enabled, configured providerId is accepted: session.created follows", async () => {
    sendStart("echo-success", "Echo success session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const payload = created.payload as { status: string; agentType: string };
    assert.equal(payload.status, "planning");
    assert.equal(payload.agentType, "custom");
  });
});

describe("stdout/stderr streaming", () => {
  test("stdout and stderr lines both produce terminal.output with the right stream + increasing sequence", async () => {
    sendStart("echo-success", "Streaming check");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    // Match the specific process lines, not merely "first stdout line": every
    // terminal session now emits an `[orbitory] sandbox: …` banner as its first
    // stdout line (Phase 4.5), so the process's own first stdout line is not
    // guaranteed to be the very first stdout envelope.
    const stdoutLine = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { stream: string; text: string }).stream === "stdout" &&
        (e.payload as { text: string }).text === "hello from stdout",
      3000,
    );
    const stderrLine = await sharedClient.waitFor(
      (e) => e.type === "terminal.output" && e.sessionId === sessionId && (e.payload as { stream: string }).stream === "stderr",
      3000,
    );

    const stdoutPayload = stdoutLine.payload as { stream: string; text: string; sequence: number };
    const stderrPayload = stderrLine.payload as { stream: string; text: string; sequence: number };
    assert.equal(stdoutPayload.text, "hello from stdout");
    assert.equal(stderrPayload.text, "hello from stderr");
    assert.ok(stdoutPayload.sequence >= 1);
    assert.ok(stderrPayload.sequence >= 1);
    assert.notEqual(stdoutPayload.sequence, stderrPayload.sequence);
  });
});

describe("process exit -> session.completed / session.failed", () => {
  test("exit code 0 produces session.completed", async () => {
    sendStart("echo-success", "Completes session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const completed = await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      5000,
    );
    const payload = completed.payload as { summary: unknown; changedFileCount: number; testStatus: unknown };
    assert.equal(payload.changedFileCount, 0);
    assert.ok(payload.summary);
    assert.ok(payload.testStatus);
  });

  test("non-zero exit code produces session.failed with the exit code in the reason", async () => {
    sendStart("echo-failure", "Fails session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const failed = await sharedClient.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      5000,
    );
    const payload = failed.payload as { reason: { en: string; ja: string }; changedFileCount: number };
    assert.match(payload.reason.en, /exited with code 1/);
    assert.equal(payload.changedFileCount, 0);
  });
});

describe("session.stop terminates the process", () => {
  test("stopping a long-running terminal session produces session.failed well before its natural exit", async () => {
    const host = hosts[0]!;
    sharedClient.send({
      type: "session.start",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {
        hostId: host.id,
        agentType: "custom",
        title: "Long-running session to stop",
        providerId: "echo-success",
      },
    });
    // Note: echo-success's fixture args hardcode --delay-ms=150 (see
    // tests/fixtures/test-agents.config.json), which is already short; the
    // point of this test is just that session.stop resolves well within
    // STOP_GRACE_MS (2s) rather than waiting out any particular delay, so
    // reusing the same fast fixture entry is fine — a hung/ignoring-SIGTERM
    // process would still be caught by the 2s SIGKILL escalation either way.
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const startedAt = Date.now();
    sharedClient.send({
      type: "session.stop",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { reason: "user_requested" },
    });

    const failed = await sharedClient.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      4000,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3000, `expected session.stop to resolve quickly, took ${elapsedMs}ms`);
    const payload = failed.payload as { reason: { en: string } };
    assert.equal(payload.reason.en, "Stopped by user.");
  });
});

describe("chat.message is delivered verbatim to stdin, never executed as a shell command", () => {
  test("a message containing shell metacharacters is echoed back verbatim, not interpreted", async () => {
    const host = hosts[0]!;
    sharedClient.send({
      type: "session.start",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {
        hostId: host.id,
        agentType: "custom",
        title: "Chat message stdin test",
        providerId: "echo-success",
      },
    });
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const dangerousLookingText = 'hello; rm -rf / && echo pwned `whoami`';
    sharedClient.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "msg_test_1", text: dangerousLookingText },
    });

    // The fixture script echoes exactly `echo: <text>` back over stdout if
    // (and only if) it received the text verbatim over stdin, un-evaluated.
    const echoLine = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === `echo: ${dangerousLookingText}`,
      3000,
    );
    assert.ok(echoLine, "expected the exact message text to be echoed back verbatim over stdout");

    // The process still exits cleanly (0), consistent with the shell
    // metacharacters never having been interpreted by anything.
    const completed = await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      3000,
    );
    assert.ok(completed);
  });
});

describe("the real product demo agent (scripts/demo-agent.js), not just the echo test fixture", () => {
  test("demo-terminal-test session runs its full marker-driven lifecycle and reaches session.completed", async () => {
    // This exercises the actual scripts/demo-agent.js end to end (via the
    // "demo-terminal-test" entry in tests/fixtures/test-agents.config.json,
    // which points at it with a relative path) — not the deterministic
    // echo-agent.js fixture used by the other tests in this file. This is
    // deliberate: a real bug in demo-agent.js (it set process.exitCode but
    // never called process.exit(), so it hung forever instead of exiting —
    // because it keeps a stdin "data" listener alive for its whole run to
    // support chat-message echoing) was caught only by manual end-to-end
    // testing, not by the echo-fixture-based tests above. This test exists
    // so that class of regression fails `npm test` automatically from now on.
    sendStart("demo-terminal-test", "Real demo agent lifecycle check");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    // The full scripted lifecycle (see scripts/demo-agent.js) takes ~5.5s;
    // give it a generous but finite timeout rather than hanging forever if
    // this regresses again.
    const completed = await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      10_000,
    );
    const payload = completed.payload as { summary: { en: string }; testStatus: { status: string } };
    assert.match(payload.summary.en, /finished successfully/);
    assert.equal(payload.testStatus.status, "passed");
  });
});

describe("provider interface behavior: resolveApproval on a terminal-backed session", () => {
  test("TerminalAgentProvider never raises approvals, so approval.decision against it is gracefully rejected", async () => {
    sendStart("echo-success", "No approvals expected here");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    sharedClient.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { approvalId: "approval_does_not_exist", decision: "approve", scope: "once" },
    });

    const error = await sharedClient.waitFor((e) => e.type === "error", 3000);
    const payload = error.payload as { code: string };
    assert.equal(payload.code, "approval_not_found");
  });
});

// ---------------------------------------------------------------------------
// Phase 3.5: output secret scrubbing + runtime safety limits.
// ---------------------------------------------------------------------------

describe("output secret scrubbing (end to end, real spawned process)", () => {
  test("no raw fixture secret ever reaches a client, on stdout or stderr; normal lines survive", async () => {
    sendStart("echo-secrets", "Secret scrubbing session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      5000,
    );

    // Every raw fake secret printed by echo-agent.js --print-secrets. If any
    // of these substrings reaches a client in ANY envelope for this session,
    // the scrubber failed.
    const rawSecrets = [
      "sk-ant-api03-fakefakefakefake1234", // Anthropic
      "sk-fakefakefakefake1234567890", // OpenAI-style
      "ghp_fakefakefakefake1234567890abcd", // GitHub classic
      "github_pat_fakefakefakefake1234567890", // GitHub fine-grained
      "AKIAFAKEFAKEFAKEFAKE", // AWS access key id
      "xoxb-fake-1234567890-abcdefghij", // Slack
      "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", // JWT signature
      "fake.bearer.value1234", // Bearer token
      "bare-fake-token-value-000", // bare-keyword assignment (TOKEN=…)
      "super-fake-assignment-value-123", // prefixed assignment (MY_API_KEY=…)
      "fakekeymaterialAAAA1111BBBB2222", // PEM body (line 1)
      "fakekeymaterialCCCC3333DDDD4444", // PEM body (line 2)
      "stderr-fake-secret-999", // stderr assignment
      "sk-stderrfakefakefake9876543210", // stderr OpenAI-style
    ];

    const sessionEnvelopes = sharedClient.received.filter((e) => e.sessionId === sessionId);
    assert.ok(sessionEnvelopes.length > 0, "expected envelopes for the session");
    for (const env of sessionEnvelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(
          serialized.includes(secret),
          false,
          `raw secret "${secret}" leaked in a ${env.type} envelope`,
        );
      }
    }

    const outputLines = sessionEnvelopes
      .filter((e) => e.type === "terminal.output")
      .map((e) => e.payload as { stream: string; text: string });

    // Redaction evidence must actually appear (positive control), on both
    // streams independently.
    assert.ok(
      outputLines.some((l) => l.stream === "stdout" && l.text.includes("[REDACTED_SECRET]")),
      "expected at least one redacted stdout line",
    );
    assert.ok(
      outputLines.some((l) => l.stream === "stderr" && l.text.includes("[REDACTED_SECRET]")),
      "expected at least one redacted stderr line",
    );

    // Non-secret lines pass through byte-for-byte.
    assert.ok(outputLines.some((l) => l.text === "this is a normal log line"));
    assert.ok(outputLines.some((l) => l.text === "another normal line after the key block"));

    // The KEY=value rule keeps the key name and redacts only the value.
    assert.ok(outputLines.some((l) => l.text === "MY_API_KEY=[REDACTED_SECRET]"));

    // The stored log buffer (served via session.snapshot / GET /sessions)
    // holds the scrubbed lines too — check over authenticated REST.
    const res = await fetch(
      `${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: AgentSession[] };
    const stored = body.sessions.find((s) => s.id === sessionId);
    assert.ok(stored, "session should appear in GET /sessions");
    const joinedLogs = stored.logs.join("\n");
    for (const secret of rawSecrets) {
      assert.equal(joinedLogs.includes(secret), false, `raw secret "${secret}" leaked into session.logs`);
    }
    assert.ok(joinedLogs.includes("[REDACTED_SECRET]"));
  });
});

describe("runtime safety: line truncation (scrub first, truncate second)", () => {
  test("an oversized line arrives both redacted and truncated", async () => {
    sendStart("echo-huge", "Huge line session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const hugeLine = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("prefix "),
      3000,
    );
    const text = (hugeLine.payload as { text: string }).text;
    assert.equal(text.includes("ghp_hugefakehugefake1234567890abcd"), false, "secret must be redacted");
    assert.ok(text.includes("[REDACTED_SECRET]"), "redaction marker expected");
    assert.ok(text.endsWith(" [TRUNCATED]"), "truncation marker expected");
    assert.ok(text.length <= 4096 + " [TRUNCATED]".length, `line too long: ${text.length}`);

    await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      5000,
    );
  });
});

describe("runtime safety: session.logs ring buffer", () => {
  test("a flooding process's stored log buffer is capped at 2000 lines", async () => {
    sendStart("echo-flood", "Flood session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      10_000,
    );

    const res = await fetch(
      `${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`,
    );
    const body = (await res.json()) as { sessions: AgentSession[] };
    const stored = body.sessions.find((s) => s.id === sessionId);
    assert.ok(stored);
    assert.ok(
      stored.logs.length <= 2000,
      `expected logs capped at 2000, got ${stored.logs.length}`,
    );
    // Oldest lines were dropped, newest kept: the very last flood line must
    // be present, the very first must not.
    assert.ok(stored.logs.includes("flood line 2500"));
    assert.equal(stored.logs.includes("flood line 1"), false);
  });
});

describe("runtime safety: maxRuntimeSeconds", () => {
  test("a process exceeding its configured max runtime is terminated and the session fails with a runtime reason", async () => {
    sendStart("echo-timeout", "Timeout session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const startedAt = Date.now();
    // echo-timeout's fixture entry sets maxRuntimeSeconds: 1 while the
    // process itself would run ~15s; the provider must kill it at ~1s.
    const failed = await sharedClient.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      6000,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 5000, `expected runtime kill well before natural exit; took ${elapsedMs}ms`);
    const payload = failed.payload as { reason: { en: string } };
    assert.match(payload.reason.en, /exceeded its maximum runtime \(1s\)/);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.5: runtime sandboxing.
// ---------------------------------------------------------------------------

describe("Phase 4.5: sandboxed terminal sessions still work end to end", () => {
  test("a sandbox-exec session emits the sandbox banner and completes normally", async () => {
    sendStart("echo-sandboxed", "Sandboxed echo session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const banner = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("[orbitory] sandbox:"),
      4000,
    );
    const bannerText = (banner.payload as { text: string }).text;
    // On macOS with sandbox-exec available it is actually sandboxed; elsewhere
    // the non-required policy honestly reports a downgrade to none.
    if (sandboxExecAvailable()) {
      assert.match(bannerText, /sandbox-exec/);
    } else {
      assert.match(bannerText, /none/);
    }

    // Normal stdout still streams through the sandboxed path.
    await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "hello from stdout",
      4000,
    );
    await sharedClient.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("a restricted-process session runs (process-group isolation, no OS boundary) and completes", async () => {
    sendStart("echo-restricted", "Restricted-process echo session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const banner = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("[orbitory] sandbox:"),
      4000,
    );
    assert.match((banner.payload as { text: string }).text, /restricted-process/);
    await sharedClient.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("an invalid/unenforceable sandbox provider is not loadable — fail closed at the client boundary", async () => {
    // `sandbox-required-container` (mode container, required true, and — since
    // Phase 5.5 made container mode real — no `image`, which is now an INVALID
    // policy) is rejected at config load on every platform, so from the client
    // it looks exactly like any other unknown/disabled provider: an error,
    // never a session. The required-but-engine-unavailable fail-closed path is
    // covered deterministically in agentConfig.test.ts via the
    // ORBITORY_DISABLE_CONTAINER_DETECTION hook.
    sendStart("sandbox-required-container", "Should fail closed");
    const next = await sharedClient.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
    assert.equal((next.payload as { code: string }).code, "invalid_payload");
  });

  test("sandbox-exec actually confines filesystem writes to the working directory (macOS)", async (t) => {
    if (!sandboxExecAvailable()) {
      t.skip("sandbox-exec unavailable on this host");
      return;
    }
    sendStart("echo-sandbox-probe", "FS write confinement probe");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const inside = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("FS_WRITE inside:"),
      5000,
    );
    const outside = await sharedClient.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("FS_WRITE outside:"),
      5000,
    );
    assert.equal((inside.payload as { text: string }).text, "FS_WRITE inside: ok");
    assert.match((outside.payload as { text: string }).text, /^FS_WRITE outside: denied/);
    await sharedClient.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("chat.message idempotency (docs/protocol.md §7)", () => {
  test("resending the same messageId delivers the message to the process exactly once", async () => {
    sendStart("echo-success", "Chat dedupe session");
    const created = await sharedClient.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const send = () =>
      sharedClient.send({
        type: "chat.message",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId,
        payload: { messageId: "dedupe_test_1", text: "only once please" },
      });
    send();
    send();

    await sharedClient.waitFor(
      (e) => e.type === "session.completed" && e.sessionId === sessionId,
      5000,
    );

    const echoes = sharedClient.received.filter(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "echo: only once please",
    );
    assert.equal(echoes.length, 1, `expected exactly one delivery, saw ${echoes.length}`);
  });
});
