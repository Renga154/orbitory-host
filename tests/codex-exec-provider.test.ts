import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexExecArgv,
  classifyCodexFailureText,
  parseCodexExecLine,
} from "../src/providers/codexExecParser.js";
import { CodexExecProvider } from "../src/providers/CodexExecProvider.js";
import { MAX_TERMINAL_LINE_CHARS, TRUNCATION_SUFFIX } from "../src/providers/AgentProvider.js";
import { defaultResolvedSandbox } from "../src/sandbox.js";
import type { TerminalAgentConfig } from "../src/agentConfig.js";
import type { AgentSession, ServerMessage } from "../src/types.js";

const FAKE_CODEX_EXEC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/fake-codex-exec.js",
);

function makeSession(): AgentSession {
  const now = new Date().toISOString();
  return {
    id: "session_codex_exec_test",
    hostId: "host_test",
    title: "Codex exec test",
    agentType: "codex",
    sessionKind: "real",
    status: "planning",
    currentSummary: { en: "Starting.", ja: "開始しています。" },
    changedFileCount: 0,
    changedFiles: [],
    testStatus: {
      status: "notStarted",
      passedCount: 0,
      failedCount: 0,
      durationSeconds: 0,
      summary: { en: "Not run.", ja: "未実行です。" },
    },
    approvalRequired: false,
    approvalRequest: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
    logs: [],
    diffSummary: { en: "No changes.", ja: "変更はありません。" },
  };
}

function makeConfig(overrides: Partial<TerminalAgentConfig> = {}): TerminalAgentConfig {
  return {
    id: "codex-exec-test",
    displayName: "Codex Exec Test",
    agentType: "codex",
    command: "/definitely/not/spawned",
    args: [],
    workingDirectory: process.cwd(),
    maxRuntimeSeconds: 5,
    approvalTimeoutSeconds: 5,
    io: "codex-jsonl",
    sandbox: defaultResolvedSandbox(),
    ...overrides,
  };
}

function waitForEvent(
  provider: CodexExecProvider,
  predicate: (event: ServerMessage) => boolean,
  timeoutMs = 2_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for provider event.")), timeoutMs);
    provider.streamEvents((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe("buildCodexExecArgv", () => {
  test("allows a host-authorized project that is not a Git repository", () => {
    assert.deepEqual(buildCodexExecArgv({ args: [] }), [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-",
    ]);
  });

  test("builds the host-authoritative first-turn command", () => {
    assert.deepEqual(buildCodexExecArgv({ args: [] }), [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-",
    ]);
  });

  test("builds the host-authoritative resume command", () => {
    assert.deepEqual(buildCodexExecArgv({ args: [] }, "thread-private-123"), [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "thread-private-123",
      "-",
    ]);
  });

  test("maps an allowlisted plan/model selection to fixed Codex flags", () => {
    assert.deepEqual(
      buildCodexExecArgv({ args: [] }, undefined, {
        launchProfileId: "plan",
        intent: "plan",
        modelId: "gpt-5.5",
        modelCliValue: "gpt-5.5",
      }),
      [
        "exec",
        "--model",
        "gpt-5.5",
        "-c",
        'sandbox_mode="read-only"',
        "--skip-git-repo-check",
        "--json",
        "-",
      ],
    );
  });

  test("uses the resume-compatible read-only config override", () => {
    assert.deepEqual(
      buildCodexExecArgv({ args: [] }, "thread-private-123", {
        launchProfileId: "review",
        intent: "review",
        modelId: "default",
      }),
      [
        "exec",
        "resume",
        "-c",
        'sandbox_mode="read-only"',
        "--skip-git-repo-check",
        "--json",
        "thread-private-123",
        "-",
      ],
    );
  });
});

describe("parseCodexExecLine", () => {
  test("classifies a missing rollout without exposing its private thread id", () => {
    const reason = classifyCodexFailureText(
      "Error: thread/resume failed: no rollout found for thread id 0199a213-private",
    );
    assert.deepEqual(reason, {
      en: "This saved Codex session is no longer available. Refresh the project list and start a new session.",
      ja: "この Codex セッションの履歴は利用できなくなりました。プロジェクト一覧を更新し、新しいセッションを開始してください。",
    });
    assert.equal(JSON.stringify(reason).includes("0199a213-private"), false);
  });

  test("captures thread.started as host-only state", () => {
    assert.deepEqual(
      parseCodexExecLine(
        '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
      ),
      {
        kind: "threadStarted",
        threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      },
    );
  });

  test("extracts only completed assistant messages as chat text", () => {
    assert.deepEqual(
      parseCodexExecLine(
        '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done safely."}}',
      ),
      { kind: "assistantMessage", text: "Done safely." },
    );
  });

  test("maps command events to path-free bilingual status copy", () => {
    assert.deepEqual(
      parseCodexExecLine(
        '{"type":"item.started","item":{"type":"command_execution","command":"cat /Users/private/.env"}}',
      ),
      {
        kind: "status",
        status: "editing",
        summary: {
          en: "Codex is running a command.",
          ja: "Codex がコマンドを実行しています。",
        },
      },
    );
  });

  test("recognizes turn lifecycle and error events", () => {
    assert.deepEqual(parseCodexExecLine('{"type":"turn.started"}'), { kind: "turnStarted" });
    assert.deepEqual(parseCodexExecLine('{"type":"turn.completed","usage":{}}'), {
      kind: "turnCompleted",
    });
    assert.deepEqual(
      parseCodexExecLine('{"type":"turn.failed","error":{"message":"turn broke"}}'),
      { kind: "turnFailed", message: "turn broke" },
    );
    assert.deepEqual(parseCodexExecLine('{"type":"error","message":"stream broke"}'), {
      kind: "processError",
      message: "stream broke",
    });
  });

  test("maps structured work items without copying their payload fields", () => {
    const cases = [
      ["reasoning", "planning", "Codex is reasoning."],
      ["file_change", "editing", "Codex is applying file changes."],
      ["mcp_tool_call", "editing", "Codex is using a tool."],
      ["web_search", "searching", "Codex is searching the web."],
      ["todo_list", "planning", "Codex updated its plan."],
    ] as const;

    for (const [itemType, status, en] of cases) {
      const parsed = parseCodexExecLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: itemType,
            path: "/Users/private/project/secret.ts",
            query: "private query",
            arguments: { token: "private-token" },
          },
        }),
      );
      assert.equal(parsed.kind, "status");
      if (parsed.kind === "status") {
        assert.equal(parsed.status, status);
        assert.equal(parsed.summary.en, en);
        assert.equal(JSON.stringify(parsed).includes("/Users/private"), false);
        assert.equal(JSON.stringify(parsed).includes("private-token"), false);
      }
    }
  });
});

describe("CodexExecProvider", () => {
  test("waits idle without spawning until the first user message", async () => {
    const provider = CodexExecProvider.forNewSession(makeSession(), makeConfig());
    const event = await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    assert.equal(event.type, "agent.status.changed");
    assert.equal(provider.getStatus("session_codex_exec_test")?.status, "idle");
  });

  test("stores user messages without echoing a duplicate server chat event", async () => {
    const provider = CodexExecProvider.forNewSession(makeSession(), makeConfig());
    const events: ServerMessage[] = [];
    provider.streamEvents((event) => events.push(event));
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    await provider.sendMessage("session_codex_exec_test", "review this; echo $HOME");

    assert.equal(provider.getStatus("session_codex_exec_test")?.messages[0]?.role, "user");
    assert.equal(
      events.some((event) => event.type === "chat.message" && event.payload.role === "user"),
      false,
    );
    assert.equal(events.some((event) => event.type === "session.updated"), true);
  });

  test("runs a first JSONL turn through stdin EOF and returns to idle", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=normal"] }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    const assistantPromise = waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" && candidate.payload.role === "assistant",
      4_000,
    );
    const idlePromise = waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
      4_000,
    );
    await provider.sendMessage("session_codex_exec_test", "first turn; $(touch should-not-run)");

    const assistant = await assistantPromise;
    await idlePromise;
    assert.equal(assistant.type, "chat.message");
    if (assistant.type === "chat.message") {
      assert.equal(assistant.payload.text, "First turn complete.");
    }
    assert.equal(provider.getStatus("session_codex_exec_test")?.status, "idle");
  });

  test("queues messages and resumes the captured Codex thread on later turns", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=normal"] }),
    );
    const events: ServerMessage[] = [];
    provider.streamEvents((event) => events.push(event));
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    const firstReply = waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" && candidate.payload.text === "Queued first complete.",
      5_000,
    );
    const secondReply = waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" && candidate.payload.text === "Queued second complete.",
      5_000,
    );
    const finalIdle = new Promise<void>((resolve, reject) => {
      let sawSecondReply = false;
      const timer = setTimeout(() => reject(new Error("Timed out waiting for final idle.")), 5_000);
      provider.streamEvents((event) => {
        if (event.type === "chat.message" && event.payload.text === "Queued second complete.") {
          sawSecondReply = true;
        }
        if (
          sawSecondReply &&
          event.type === "agent.status.changed" &&
          event.payload.status === "idle"
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await provider.sendMessage("session_codex_exec_test", "queued one");
    await provider.sendMessage("session_codex_exec_test", "queued two");
    await firstReply;
    await secondReply;
    await finalIdle;

    assert.equal(provider.getStatus("session_codex_exec_test")?.status, "idle");
    assert.equal(events.some((event) => event.type === "session.completed"), false);
  });

  test("keeps a resumable thread available after one unclassified turn failure", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=recoverable-turn-failure"] }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    await provider.sendMessage("session_codex_exec_test", "establish recoverable thread");
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" &&
        candidate.payload.text === "Recoverable thread established.",
      5_000,
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
      5_000,
    );

    await provider.sendMessage("session_codex_exec_test", "transient failure");
    const retryable = await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" &&
        candidate.payload.status === "idle" &&
        candidate.payload.currentSummary.en.includes("retry"),
      5_000,
    );
    assert.equal(retryable.type, "agent.status.changed");
    assert.equal(provider.getStatus("session_codex_exec_test")?.status, "idle");

    await provider.sendMessage("session_codex_exec_test", "retry after failure");
    const recovered = await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" && candidate.payload.text === "Recovered on the next turn.",
      5_000,
    );
    assert.equal(recovered.type, "chat.message");
  });

  test("keeps a resumable thread available after an unclassified nonzero exit", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=recoverable-turn-failure"] }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    await provider.sendMessage("session_codex_exec_test", "establish recoverable thread");
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" &&
        candidate.payload.text === "Recoverable thread established.",
      5_000,
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
      5_000,
    );

    await provider.sendMessage("session_codex_exec_test", "abrupt failure");
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" &&
        candidate.payload.status === "idle" &&
        candidate.payload.currentSummary.en.includes("retry"),
      5_000,
    );

    await provider.sendMessage("session_codex_exec_test", "retry after abrupt failure");
    const recovered = await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" &&
        candidate.payload.text === "Recovered after the abrupt failure.",
      5_000,
    );
    assert.equal(recovered.type, "chat.message");
  });

  test("never emits or stores raw thread ids, host paths, or process secrets", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=privacy"] }),
    );
    const events: ServerMessage[] = [];
    provider.streamEvents((event) => events.push(event));
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    const replyPromise = waitForEvent(
      provider,
      (candidate) => candidate.type === "chat.message" && candidate.payload.role === "assistant",
      5_000,
    );
    await provider.sendMessage("session_codex_exec_test", "privacy");
    const reply = await replyPromise;
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
      5_000,
    );

    const serialized = JSON.stringify({ events, snapshot: provider.getStatus("session_codex_exec_test") });
    for (const forbidden of [
      "0199a213-81c0-7800-8aa1-bbab2a035a53",
      "/Users/private/project/secret.ts",
      "src/private/secret.ts",
      "sk-fakecodexsecret123456789",
      "ghp_fakecodexsecret1234567890",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must remain host-only`);
    }
    assert.equal(reply.type, "chat.message");
    if (reply.type === "chat.message") {
      assert.match(reply.payload.text, /\[REDACTED_(?:SECRET|PATH)\]/);
    }
  });

  test("stops an active SIGTERM-resistant child with the shared escalation path", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=linger"] }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    await provider.sendMessage("session_codex_exec_test", "linger");
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "editing",
      4_000,
    );

    const failedPromise = waitForEvent(
      provider,
      (candidate) => candidate.type === "session.failed",
      5_000,
    );
    const startedAt = Date.now();
    await provider.stopSession("session_codex_exec_test");
    const failed = await failedPromise;

    assert.ok(Date.now() - startedAt >= 1_500, "SIGKILL escalation should be exercised");
    assert.ok(Date.now() - startedAt < 4_500, "stop should remain bounded");
    assert.equal(failed.type, "session.failed");
    if (failed.type === "session.failed") {
      assert.equal(failed.payload.reason.en, "Stopped by user.");
    }
  });

  test("uses a host-supplied existing thread id on the first turn", async () => {
    const privateThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=normal"] }),
      privateThreadId,
    );
    const events: ServerMessage[] = [];
    provider.streamEvents((event) => events.push(event));
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );

    const replyPromise = waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "chat.message" && candidate.payload.text === "Existing thread resumed.",
      5_000,
    );
    await provider.sendMessage("session_codex_exec_test", "existing resume");
    await replyPromise;

    assert.equal(JSON.stringify(events).includes(privateThreadId), false);
  });

  test("returns safe guidance when a saved Codex rollout disappeared", async () => {
    const privateThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=stale-resume"] }),
      privateThreadId,
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    const failedPromise = waitForEvent(
      provider,
      (candidate) => candidate.type === "session.failed",
      5_000,
    );

    await provider.sendMessage("session_codex_exec_test", "continue safely");
    const failed = await failedPromise;

    assert.equal(failed.type, "session.failed");
    if (failed.type === "session.failed") {
      assert.match(failed.payload.reason.en, /saved Codex session is no longer available/);
      assert.equal(failed.payload.reason.en.includes(privateThreadId), false);
    }
    const snapshot = provider.getStatus("session_codex_exec_test");
    assert.match(snapshot?.currentSummary.en ?? "", /saved Codex session is no longer available/);
    assert.equal(snapshot?.currentSummary.en.includes(privateThreadId), false);
  });

  test("scrubs oversized assistant text before applying the shared line cap", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({ command: FAKE_CODEX_EXEC, args: ["--scenario=oversized"] }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    const replyPromise = waitForEvent(
      provider,
      (candidate) => candidate.type === "chat.message" && candidate.payload.role === "assistant",
      5_000,
    );
    await provider.sendMessage("session_codex_exec_test", "oversized");
    const reply = await replyPromise;

    assert.equal(reply.type, "chat.message");
    if (reply.type === "chat.message") {
      assert.ok(reply.payload.text.endsWith(TRUNCATION_SUFFIX));
      assert.ok(reply.payload.text.length <= MAX_TERMINAL_LINE_CHARS + TRUNCATION_SUFFIX.length);
      assert.equal(reply.payload.text.includes("sk-fakecodexsecret123456789"), false);
      assert.equal(reply.payload.text.includes("/Users/private/project/secret.ts"), false);
    }
  });

  test("enforces maxRuntimeSeconds independently for each short-lived turn", async () => {
    const provider = CodexExecProvider.forNewSession(
      makeSession(),
      makeConfig({
        command: FAKE_CODEX_EXEC,
        args: ["--scenario=linger"],
        maxRuntimeSeconds: 0.05,
      }),
    );
    await waitForEvent(
      provider,
      (candidate) =>
        candidate.type === "agent.status.changed" && candidate.payload.status === "idle",
    );
    const failedPromise = waitForEvent(
      provider,
      (candidate) => candidate.type === "session.failed",
      5_000,
    );
    await provider.sendMessage("session_codex_exec_test", "linger");
    const failed = await failedPromise;

    assert.equal(failed.type, "session.failed");
    if (failed.type === "session.failed") {
      assert.match(failed.payload.reason.en, /maximum turn runtime \(0\.05s\)/);
    }
  });
});
