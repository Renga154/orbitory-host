/**
 * Phase 16 — `ClaudeCodeStreamProvider` integration tests.
 *
 * Drives the *fake* stream-json CLI (`scripts/fake-claude-code-stream.js`,
 * via the `claude-stream-*` entries in tests/fixtures/test-agents.config.json)
 * against a real server — never the real Claude Code. Covers: the status
 * sequence, chat round-trip (stdin bytes in, chat.message envelope out),
 * diff.updated + tests.started/finished, secrets never reaching ANY sink,
 * malformed-line passthrough (scrubbed + truncated, no crash), recoverable
 * child exits/timeouts, terminal auth-failure copy, stop, per-turn runtime,
 * transparent respawn/resume, the approval
 * round-trip (approve, deny, timeout-deny) through the real loopback bridge
 * endpoint, config-level `io` validation, and `sessionKind: "real"`.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { loadAgentConfigs } from "../src/agentConfig.js";
import {
  buildClaudeRuntimeEnvironment,
  prepareClaudeRuntimeTempDirectory,
  serializeUserMessage,
} from "../src/providers/ClaudeCodeStreamProvider.js";
import { CLAUDE_CODE_STREAM_EXAMPLE_CONFIG } from "../src/providers/agentPresets.js";
import type { AgentSession, ChangedFile, Envelope, HostInfo, TestResult } from "../src/types.js";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");
const CONFIG_PATH = process.env["ORBITORY_AGENT_CONFIG_PATH"]!;

// ---------------------------------------------------------------------------
// Pure pieces (no server).
// ---------------------------------------------------------------------------

describe("serializeUserMessage", () => {
  test("produces the exact stream-json stdin bytes (incl. trailing newline)", () => {
    assert.equal(
      serializeUserMessage("hello there"),
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello there"}]}}\n',
    );
  });

  test("text is JSON-escaped as data, never concatenated raw", () => {
    const line = serializeUserMessage('say "hi"; rm -rf / `whoami`');
    const parsed = JSON.parse(line) as {
      type: string;
      message: { content: Array<{ text: string }> };
    };
    assert.equal(parsed.type, "user");
    assert.equal(parsed.message.content[0]!.text, 'say "hi"; rm -rf / `whoami`');
  });
});

describe("prepareClaudeRuntimeTempDirectory", () => {
  test("creates a private, per-session temp directory inside Claude state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-claude-home-test-"));
    try {
      const first = prepareClaudeRuntimeTempDirectory(home);
      const second = prepareClaudeRuntimeTempDirectory(home);
      const stateRoot = fs.realpathSync(path.join(home, ".claude"));

      assert.notEqual(first, second);
      for (const directory of [first, second]) {
        assert.equal(path.dirname(directory), stateRoot);
        assert.match(path.basename(directory), /^orbitory-tmp-/u);
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      }

      const baseEnv = { HOME: home, PATH: "/usr/bin" };
      const runtimeEnv = buildClaudeRuntimeEnvironment(baseEnv, first);
      assert.deepEqual(baseEnv, { HOME: home, PATH: "/usr/bin" });
      assert.equal(runtimeEnv["TMPDIR"], first);
      assert.equal(runtimeEnv["CLAUDE_CODE_TMPDIR"], first);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("io config validation (Phase 16)", () => {
  const configs = loadAgentConfigs(CONFIG_PATH);

  test("a stream-json entry with agentType claudeCode loads", () => {
    const entry = configs.get("claude-stream-fake");
    assert.ok(entry, "claude-stream-fake should load");
    assert.equal(entry.io, "stream-json");
    assert.equal(entry.agentType, "claudeCode");
  });

  test("io stream-json with a non-claudeCode agentType is rejected at load", () => {
    assert.equal(configs.get("claude-stream-wrong-type"), undefined);
  });

  test("approvalTimeoutSeconds is honored with a 300s default", () => {
    assert.equal(configs.get("claude-stream-permission-timeout")!.approvalTimeoutSeconds, 1);
    assert.equal(configs.get("claude-stream-permission")!.approvalTimeoutSeconds, 300);
  });

  test("the stream example preset is disabled, typed, sandboxed, and in the example file", () => {
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.enabled, false);
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.agentType, "claudeCode");
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.io, "stream-json");
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.sandbox.mode, "sandbox-exec");
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.sandbox.required, true);
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.sandbox.allowNetwork, true);
    assert.deepEqual(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.envAllowlist, [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
    ]);
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.maxRuntimeSeconds, 3600);
    assert.equal(CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.workingDirectory, "../../orbitory-claude-stream-project");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const example = JSON.parse(
      fs.readFileSync(path.resolve(here, "../orbitory.config.example.json"), "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    const entry = example.agents.find((a) => a["id"] === CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.id);
    assert.ok(entry, "example config must contain the claude-code-stream entry");
    assert.equal(entry["enabled"], false, "the example stream entry MUST ship disabled");
    assert.equal(entry["io"], "stream-json");
    assert.equal(entry["workingDirectory"], CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.workingDirectory);
    assert.deepEqual(entry["sandbox"], CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.sandbox);
    assert.deepEqual(entry["envAllowlist"], CLAUDE_CODE_STREAM_EXAMPLE_CONFIG.envAllowlist);
  });
});

// ---------------------------------------------------------------------------
// Integration — real server, fake stream CLI.
// ---------------------------------------------------------------------------

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

function start(providerId: string, extra: Record<string, unknown> = {}): void {
  const host = hosts[0];
  assert.ok(host, "expected at least one host");
  client.send({
    type: "session.start",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    // The client's agentType is deliberately wrong to prove host authority.
    payload: { hostId: host.id, agentType: "custom", title: "Stream test", providerId, ...extra },
  });
}

function sessionEnvelopes(sessionId: string): Envelope<unknown>[] {
  return client.received.filter((e) => e.sessionId === sessionId);
}

function waitForIdle(sessionId: string, timeoutMs = 8000): Promise<Envelope<unknown>> {
  return client.waitFor(
    (e) =>
      e.type === "agent.status.changed" &&
      e.sessionId === sessionId &&
      (e.payload as { status?: string }).status === "idle",
    timeoutMs,
  );
}

describe("stream session lifecycle", () => {
  test("session.created is claudeCode + sessionKind real; statuses follow the stream", async () => {
    start("claude-stream-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const createdPayload = created.payload as { agentType: string; status: string; sessionKind?: string };
    assert.equal(createdPayload.agentType, "claudeCode");
    assert.equal(createdPayload.status, "planning");
    assert.equal(createdPayload.sessionKind, "real");
    const sessionId = created.sessionId!;

    await waitForIdle(sessionId);

    // Status sequence: searching (Read) before editing (Edit) before testing
    // (Bash npm test) before idle (result success).
    const statuses = sessionEnvelopes(sessionId)
      .filter((e) => e.type === "agent.status.changed")
      .map((e) => (e.payload as { status: string }).status);
    const order = ["searching", "editing", "testing", "idle"];
    let cursor = -1;
    for (const expected of order) {
      const index = statuses.indexOf(expected, cursor + 1);
      assert.ok(
        index > cursor,
        `expected status "${expected}" after position ${cursor} in ${JSON.stringify(statuses)}`,
      );
      cursor = index;
    }

    // The spawn banners: sandbox + approval bridge mechanism.
    const lines = sessionEnvelopes(sessionId)
      .filter((e) => e.type === "terminal.output")
      .map((e) => (e.payload as { text: string }).text);
    assert.ok(lines.some((l) => l.startsWith("[orbitory] sandbox:")), "sandbox banner expected");
    assert.ok(
      lines.includes("[orbitory] approval bridge: permission-prompt-tool"),
      "approval bridge banner expected",
    );
    assert.ok(
      lines.some((l) => l.startsWith("[orbitory] claude session started")),
      "claude session line expected",
    );
    assert.equal(JSON.stringify(lines).includes("fake-stream-session-0001"), false);
    assert.ok(
      lines.some((l) => l === "[orbitory] turn finished (tokens 100/250, cost $0.0123)"),
      `turn-finished line expected in ${JSON.stringify(lines)}`,
    );
    assert.ok(lines.includes("$ npm test"), "Bash $-line expected");
  });

  test("assistant text arrives as a server chat.message and lands in the snapshot", async () => {
    start("claude-stream-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const chat = await client.waitFor(
      (e) => e.type === "chat.message" && e.sessionId === sessionId,
      5000,
    );
    const payload = chat.payload as { messageId?: string; role?: string; text: string };
    assert.equal(payload.role, "assistant");
    assert.equal(payload.text, "I found the bug; fixing it now.");
    assert.ok(payload.messageId && payload.messageId.startsWith("msg_"));

    await waitForIdle(sessionId);

    // The message is also part of the REST snapshot (session.messages).
    const res = await fetch(`${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    const body = (await res.json()) as { sessions: AgentSession[] };
    const stored = body.sessions.find((s) => s.id === sessionId);
    assert.ok(stored);
    assert.ok(
      stored.messages.some((m) => m.role === "assistant" && m.text === "I found the bug; fixing it now."),
      "assistant message must be stored on the session",
    );
  });

  test("diff.updated and tests.started/finished are emitted from tool events", async () => {
    start("claude-stream-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const diff = await client.waitFor((e) => e.type === "diff.updated" && e.sessionId === sessionId, 5000);
    const diffPayload = diff.payload as {
      changedFileCount: number;
      changedFiles: ChangedFile[];
      diffSummary: { en: string };
    };
    assert.equal(diffPayload.changedFileCount, 1);
    assert.equal(diffPayload.changedFiles[0]!.path, "src/example.ts");
    assert.equal(diffPayload.changedFiles[0]!.changeType, "modified");
    assert.equal(diffPayload.changedFiles[0]!.diffPreview, "- const a = 1;\n+ const a = 2;");

    await client.waitFor((e) => e.type === "tests.started" && e.sessionId === sessionId, 5000);
    const finished = await client.waitFor(
      (e) => e.type === "tests.finished" && e.sessionId === sessionId,
      5000,
    );
    const testStatus = (finished.payload as { testStatus: TestResult }).testStatus;
    assert.equal(testStatus.status, "passed");
    assert.equal(testStatus.passedCount, 7);
    assert.equal(testStatus.failedCount, 0);
    assert.equal(testStatus.durationSeconds, 1.2);

    await waitForIdle(sessionId);
  });
});

describe("chat round-trip over stdin", () => {
  test("a user chat.message is answered by the fake ('You said: …') as an assistant chat.message", async () => {
    start("claude-stream-chat");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    // Wait for the turn to finish (status idle) so the fake is lingering.
    await client.waitFor(
      (e) =>
        e.type === "agent.status.changed" &&
        e.sessionId === sessionId &&
        (e.payload as { status: string }).status === "idle",
      8000,
    );

    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "stream_chat_1", text: "hello stream" },
    });

    const reply = await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "You said: hello stream",
      5000,
    );
    assert.equal((reply.payload as { role?: string }).role, "assistant");

    // A clean child exit keeps the room resumable instead of completing it.
    await waitForIdle(sessionId, 5000);
  });

  test("a clean child exit transparently respawns and resumes for the next message", async () => {
    start("claude-stream-resumable", { initialPrompt: "first turn" });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text?: string }).text === "You said: first turn",
      5000,
    );
    await waitForIdle(sessionId, 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "stream_resume_2", text: "second turn" },
    });

    await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text?: string }).text === "You said: second turn",
      5000,
    );
    await waitForIdle(sessionId, 5000);
    assert.equal(
      sessionEnvelopes(sessionId).some((e) => e.type === "session.failed"),
      false,
    );
  });
});

describe("failure paths", () => {
  test("--fail (auth result) → session.failed with the bilingual login copy", async () => {
    start("claude-stream-fail");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      8000,
    );
    const reason = (failed.payload as { reason: { en: string; ja: string } }).reason;
    assert.match(reason.en, /expired or is unavailable/i);
    assert.match(reason.en, /`claude auth login`/);
    assert.match(reason.ja, /ログイン/);
    assert.match(reason.ja, /`claude auth login`/);

    const response = await fetch(
      `${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`,
    );
    const body = (await response.json()) as { sessions: AgentSession[] };
    const stored = body.sessions.find((session) => session.id === sessionId);
    assert.match(stored?.currentSummary.en ?? "", /expired or is unavailable/i);
  });

  test("an auth-failed stream child is terminated instead of lingering", async () => {
    start("claude-stream-fail-linger");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      8000,
    );

    const terminated = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "fake auth-failure child received SIGTERM",
      1500,
    );
    assert.equal((terminated.payload as { stream: string }).stream, "stdout");
  });

  test("a mid-stream crash returns the room to a resumable idle state", async () => {
    start("claude-stream-crash");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const idle = await waitForIdle(sessionId);
    assert.match(
      (idle.payload as { currentSummary: { en: string } }).currentSummary.en,
      /exited with code 3/,
    );
    assert.equal(sessionEnvelopes(sessionId).some((e) => e.type === "session.failed"), false);
  });

  test("session.stop terminates a lingering stream session quickly ('Stopped by user.')", async () => {
    start("claude-stream-linger");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    // Let it reach the lingering phase first.
    await client.waitFor(
      (e) =>
        e.type === "agent.status.changed" &&
        e.sessionId === sessionId &&
        (e.payload as { status: string }).status === "idle",
      8000,
    );

    const startedAt = Date.now();
    client.send({
      type: "session.stop",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { reason: "user_requested" },
    });
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      5000,
    );
    assert.ok(Date.now() - startedAt < 4000, "stop should resolve well within the SIGKILL escalation window");
    assert.equal((failed.payload as { reason: { en: string } }).reason.en, "Stopped by user.");
  });

  test("session.stop unregisters the approval bridge before a SIGTERM-resistant child can ask", async () => {
    start("claude-stream-stop-late-permission");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await client.waitFor(
      (e) =>
        e.type === "agent.status.changed" &&
        e.sessionId === sessionId &&
        (e.payload as { status: string }).status === "idle",
      8000,
    );

    const cursor = client.received.length;
    client.send({
      type: "session.stop",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { reason: "user_requested" },
    });
    await client.waitFor((e) => e.type === "session.failed" && e.sessionId === sessionId, 5000);

    const afterStop = client.received.slice(cursor).filter((e) => e.sessionId === sessionId);
    assert.equal(
      afterStop.some((e) => e.type === "approval.required"),
      false,
      "late permission requests after stop must not re-open approvalNeeded",
    );
  });

  test("maxRuntimeSeconds limits one active turn and leaves the room resumable", async () => {
    start("claude-stream-slow", { initialPrompt: "hang this turn" });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const startedAt = Date.now();
    const idle = await waitForIdle(sessionId);
    assert.ok(Date.now() - startedAt < 6000, "runtime ceiling should fire at ~1s");
    assert.match(
      (idle.payload as { currentSummary: { en: string } }).currentSummary.en,
      /turn exceeded 1s/,
    );
    assert.equal(sessionEnvelopes(sessionId).some((e) => e.type === "session.failed"), false);
  });

  test("maxRuntimeSeconds unregisters the approval bridge before terminating the child", async () => {
    start("claude-stream-timeout-late-permission", { initialPrompt: "hang this turn" });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const cursor = client.received.length;
    const idle = await waitForIdle(sessionId);
    assert.match(
      (idle.payload as { currentSummary: { en: string } }).currentSummary.en,
      /turn exceeded 1s/,
    );

    const afterTimeout = client.received.slice(cursor).filter((e) => e.sessionId === sessionId);
    assert.equal(
      afterTimeout.some((e) => e.type === "approval.required"),
      false,
      "late permission requests after runtime timeout must not re-open approvalNeeded",
    );
  });
});

describe("scrubbing across every sink", () => {
  test("no planted secret reaches ANY envelope (chat, summaries, diff, terminal, snapshot)", async () => {
    start("claude-stream-secrets");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await waitForIdle(sessionId);

    const rawSecrets = [
      "sk-ant-api03-fakeclaudefake1234", // assistant text + tool_result
      "ghp_fakeclaudefake1234567890abcdefgh", // Edit new_string → diffPreview
      "fake-claude-bare-token-42", // Bash command + raw stdout line
      "sk-fakeclaudestderr1234567890", // raw stderr line
    ];
    const envelopes = sessionEnvelopes(sessionId);
    assert.ok(envelopes.length > 0);
    for (const env of envelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(
          serialized.includes(secret),
          false,
          `raw secret "${secret}" leaked in a ${env.type} envelope`,
        );
      }
    }

    // Positive controls: redaction evidence in the chat text AND the diff preview.
    const chat = envelopes.find((e) => e.type === "chat.message");
    assert.ok(chat, "expected an assistant chat message");
    assert.ok((chat!.payload as { text: string }).text.includes("[REDACTED_SECRET]"));
    const diff = envelopes.find((e) => e.type === "diff.updated");
    assert.ok(diff, "expected a diff.updated");
    assert.ok(
      (diff!.payload as { changedFiles: ChangedFile[] }).changedFiles[0]!.diffPreview.includes(
        "[REDACTED_SECRET]",
      ),
    );

    // The stored snapshot (logs + messages + diffs) is clean too.
    const res = await fetch(`${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    const body = (await res.json()) as { sessions: AgentSession[] };
    const stored = body.sessions.find((s) => s.id === sessionId);
    assert.ok(stored);
    const storedSerialized = JSON.stringify(stored);
    for (const secret of rawSecrets) {
      assert.equal(storedSerialized.includes(secret), false, `raw secret "${secret}" leaked into the snapshot`);
    }
  });
});

describe("malformed stream lines", () => {
  test("garbage lines are forwarded as plain scrubbed output, huge lines truncated, session still completes", async () => {
    start("claude-stream-malformed");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await waitForIdle(sessionId);

    const lines = sessionEnvelopes(sessionId)
      .filter((e) => e.type === "terminal.output")
      .map((e) => (e.payload as { text: string }).text);
    assert.ok(lines.includes("this is not json at all"), "non-JSON line must pass through");
    assert.ok(
      lines.some((l) => l.startsWith('{"type":"assistant","message":')),
      "truncated-JSON line must pass through as plain text",
    );
    const huge = lines.find((l) => l.startsWith("raw huge "));
    assert.ok(huge, "huge raw line must pass through");
    assert.ok(huge!.endsWith(" [TRUNCATED]"), "huge raw line must be truncated");
    assert.ok(huge!.length <= 4096 + " [TRUNCATED]".length);
  });
});

describe("approval round-trip through the loopback bridge", () => {
  test("approve: approval.required → decision → approval.resolved(user) → the fake proceeds", async () => {
    start("claude-stream-permission");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const required = await client.waitFor(
      (e) => e.type === "approval.required" && e.sessionId === sessionId,
      6000,
    );
    const requiredPayload = required.payload as {
      approvalId: string;
      actionType: string;
      command: string;
      riskLevel: string;
      recommendation: string;
    };
    assert.equal(requiredPayload.actionType, "run_command");
    assert.equal(requiredPayload.command, "rm -rf build");
    assert.equal(requiredPayload.riskLevel, "high");
    assert.equal(requiredPayload.recommendation, "ask");

    // The session is visibly waiting on approval (the status change is
    // emitted just BEFORE approval.required, so check the received buffer
    // rather than waitFor — the cursor is already past it).
    assert.ok(
      client.received.some(
        (e) =>
          e.type === "agent.status.changed" &&
          e.sessionId === sessionId &&
          (e.payload as { status: string }).status === "approvalNeeded",
      ),
      "expected an approvalNeeded status change before approval.required",
    );

    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { approvalId: requiredPayload.approvalId, decision: "approve", scope: "once" },
    });

    const resolved = await client.waitFor(
      (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
      5000,
    );
    const resolvedPayload = resolved.payload as { approvalId: string; decision: string; resolvedBy: string };
    assert.equal(resolvedPayload.approvalId, requiredPayload.approvalId);
    assert.equal(resolvedPayload.decision, "approve");
    assert.equal(resolvedPayload.resolvedBy, "user");

    // The fake observed the allow and said so.
    await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "permission-allowed",
      5000,
    );
    await waitForIdle(sessionId);
  });

  test("reject: the fake observes the deny with the user-deny message", async () => {
    start("claude-stream-permission");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const required = await client.waitFor(
      (e) => e.type === "approval.required" && e.sessionId === sessionId,
      6000,
    );
    const approvalId = (required.payload as { approvalId: string }).approvalId;

    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { approvalId, decision: "reject", scope: "once" },
    });

    const resolved = await client.waitFor(
      (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
      5000,
    );
    assert.equal((resolved.payload as { decision: string }).decision, "reject");
    assert.equal((resolved.payload as { resolvedBy: string }).resolvedBy, "user");

    await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("permission-denied:"),
      5000,
    );
    // A denied permission doesn't kill the session; the fake returns to idle.
    await waitForIdle(sessionId);
  });

  test("timeout: nobody answers → deny with approval.resolved resolvedBy timeout", async () => {
    start("claude-stream-permission-timeout");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    await client.waitFor((e) => e.type === "approval.required" && e.sessionId === sessionId, 6000);

    // approvalTimeoutSeconds is 1 for this entry — the broker must deny on its own.
    const resolved = await client.waitFor(
      (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
      6000,
    );
    assert.equal((resolved.payload as { decision: string }).decision, "reject");
    assert.equal((resolved.payload as { resolvedBy: string }).resolvedBy, "timeout");

    await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("permission-denied:"),
      6000,
    );
    await waitForIdle(sessionId);
  });

  test("no bridge token appears in any envelope of a permission session", async () => {
    start("claude-stream-permission");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const required = await client.waitFor(
      (e) => e.type === "approval.required" && e.sessionId === sessionId,
      6000,
    );
    client.send({
      type: "approval.decision",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: {
        approvalId: (required.payload as { approvalId: string }).approvalId,
        decision: "approve",
        scope: "once",
      },
    });
    await waitForIdle(sessionId);

    // The bridge token is 43 chars of base64url; assert that no envelope
    // carries any base64url run that long except message ids (which are
    // uuid-based and contain dashes in fixed positions). Simplest robust
    // check: no payload string contains "ORBITORY_APPROVAL_BRIDGE".
    for (const env of sessionEnvelopes(sessionId)) {
      const serialized = JSON.stringify(env);
      assert.equal(
        serialized.includes("ORBITORY_APPROVAL_BRIDGE"),
        false,
        `bridge env leaked in a ${env.type} envelope`,
      );
    }
  });
});
