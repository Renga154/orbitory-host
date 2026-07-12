/**
 * Phase 16 — unit tests for the pure Claude Code stream-json parser/mapper
 * (`src/providers/claudeStreamParser.ts`). No server, no process, no real
 * CLI: every §4.2 mapping row is exercised directly, plus the argv builder,
 * the unparseable fallback, auth-string detection, scrubbing of derived
 * strings, and truncation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  APPROVAL_PROMPT_TOOL_NAME,
  AUTH_FAILURE_REASON,
  buildClaudeArgv,
  createStreamMapContext,
  DIFF_PREVIEW_MAX_CHARS,
  extractTestCounts,
  isAuthFailureText,
  isTestCommand,
  mapEventToEmissions,
  parseClaudeStreamLine,
  WAITING_FOR_MESSAGE_SUMMARY,
  type StreamEmission,
} from "../src/providers/claudeStreamParser.js";
import { scrubSecrets } from "../src/scrubbing.js";

/** Fresh context with the real scrubber, exactly like the provider wires it. */
function ctx() {
  return createStreamMapContext((text) => scrubSecrets(text));
}

function mapLine(line: string, context = ctx()): StreamEmission[] {
  return mapEventToEmissions(parseClaudeStreamLine(line), context);
}

// ---------------------------------------------------------------------------
// buildClaudeArgv
// ---------------------------------------------------------------------------

describe("buildClaudeArgv", () => {
  test("enables verbose output required by current Claude stream-json mode", () => {
    const argv = buildClaudeArgv({ args: [] }, "uuid-verbose");
    assert.ok(argv.includes("--verbose"));
  });

  test("operator args first, then the exact host-authoritative stream flags", () => {
    const argv = buildClaudeArgv({ args: ["--model", "claude-sonnet-4"] }, "uuid-123");
    assert.deepEqual(argv, [
      "--model",
      "claude-sonnet-4",
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--session-id",
      "uuid-123",
    ]);
  });

  test("with a bridge, appends the permission-prompt-tool + strict MCP config flags", () => {
    const argv = buildClaudeArgv({ args: [] }, "uuid-456", {
      toolName: APPROVAL_PROMPT_TOOL_NAME,
      mcpConfigPath: "/tmp/orbitory-mcp/mcp.json",
    });
    assert.deepEqual(argv, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--session-id",
      "uuid-456",
      "--permission-prompt-tool",
      APPROVAL_PROMPT_TOOL_NAME,
      "--mcp-config",
      "/tmp/orbitory-mcp/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("maps an allowlisted plan/model selection to fixed Claude flags", () => {
    const argv = buildClaudeArgv({ args: [] }, "uuid-plan", undefined, {
      launchProfileId: "plan",
      intent: "plan",
      modelId: "sonnet",
      modelCliValue: "sonnet",
    });
    assert.deepEqual(argv.slice(0, 4), ["--model", "sonnet", "--permission-mode", "plan"]);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeStreamLine
// ---------------------------------------------------------------------------

describe("parseClaudeStreamLine", () => {
  test("system/init", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", model: "claude-sonnet-4" }),
    );
    assert.deepEqual(event, { kind: "systemInit", claudeSessionId: "abc-123", model: "claude-sonnet-4" });
  });

  test("system with another subtype is ignored (systemOther)", () => {
    assert.equal(parseClaudeStreamLine(JSON.stringify({ type: "system", subtype: "hook" })).kind, "systemOther");
  });

  test("stream_event partial deltas are recognized and ignored", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } }),
    );
    assert.equal(event.kind, "partial");
    assert.deepEqual(mapEventToEmissions(event, ctx()), []);
  });

  test("assistant text + tool_use blocks", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/a.ts" } },
          ],
        },
      }),
    );
    assert.equal(event.kind, "assistant");
    if (event.kind === "assistant") {
      assert.equal(event.blocks.length, 2);
      assert.deepEqual(event.blocks[0], { type: "text", text: "Let me look." });
      assert.deepEqual(event.blocks[1], {
        type: "toolUse",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "src/a.ts" },
      });
    }
  });

  test("user tool_result (array content + is_error)", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              is_error: true,
              content: [{ type: "text", text: "boom" }],
            },
          ],
        },
      }),
    );
    assert.deepEqual(event, {
      kind: "toolResult",
      results: [{ toolUseId: "toolu_9", text: "boom", isError: true }],
    });
  });

  test("user event without tool_result blocks is ignored (userOther)", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    );
    assert.equal(event.kind, "userOther");
    assert.deepEqual(mapEventToEmissions(event, ctx()), []);
  });

  test("result with usage and cost (the spike-captured shape)", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All done.",
        total_cost_usd: 0.0345,
        usage: { input_tokens: 120, output_tokens: 456 },
      }),
    );
    assert.deepEqual(event, {
      kind: "result",
      isError: false,
      resultText: "All done.",
      inputTokens: 120,
      outputTokens: 456,
      costUsd: 0.0345,
    });
  });

  test("result subtype error counts as an error even without is_error", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution", result: "it broke" }),
    );
    assert.equal(event.kind, "result");
    if (event.kind === "result") assert.equal(event.isError, true);
  });

  test("non-JSON, non-object JSON, and unknown types are unparseable", () => {
    assert.equal(parseClaudeStreamLine("plain text output").kind, "unparseable");
    assert.equal(parseClaudeStreamLine('"just a string"').kind, "unparseable");
    assert.equal(parseClaudeStreamLine("[1,2,3]").kind, "unparseable");
    assert.equal(parseClaudeStreamLine('{"type":"some_future_event"}').kind, "unparseable");
    assert.equal(parseClaudeStreamLine('{"no_type":true}').kind, "unparseable");
  });
});

// ---------------------------------------------------------------------------
// mapEventToEmissions — the §4.2 table, row by row
// ---------------------------------------------------------------------------

describe("mapEventToEmissions: system/init", () => {
  test("planning status + the [orbitory] claude session line", () => {
    const emissions = mapLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", model: "claude-sonnet-4" }),
    );
    assert.equal(emissions.length, 2);
    assert.deepEqual(emissions[0], {
      type: "status",
      status: "planning",
      summary: { en: "Claude Code session started.", ja: "Claude Code セッションを開始しました。" },
    });
    assert.deepEqual(emissions[1], {
      type: "terminalLine",
      stream: "stdout",
      text: "[orbitory] claude session abc-123 (model claude-sonnet-4)",
    });
  });
});

describe("mapEventToEmissions: assistant text → chat", () => {
  test("a complete text turn becomes an assistant chat emission", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I found the bug." }] },
      }),
    );
    assert.deepEqual(emissions, [{ type: "chat", role: "assistant", text: "I found the bug." }]);
  });

  test("whitespace-only text produces nothing", () => {
    const emissions = mapLine(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "  \n" }] } }),
    );
    assert.deepEqual(emissions, []);
  });

  test("chat text is scrubbed (model prose can echo secrets it read)", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Your key is sk-ant-api03-fakeclaudefake1234 by the way." }],
        },
      }),
    );
    assert.equal(emissions.length, 1);
    const chat = emissions[0]!;
    assert.equal(chat.type, "chat");
    if (chat.type === "chat") {
      assert.equal(chat.text.includes("sk-ant-api03-fakeclaudefake1234"), false);
      assert.ok(chat.text.includes("[REDACTED_SECRET]"));
    }
  });
});

describe("mapEventToEmissions: search tools → searching", () => {
  const searchCases: Array<{ name: string; input: Record<string, unknown>; expectEn: RegExp }> = [
    { name: "Read", input: { file_path: "src/auth/session.ts" }, expectEn: /Reading src\/auth\/session\.ts/ },
    { name: "Grep", input: { pattern: "refreshToken" }, expectEn: /Searching the code for "refreshToken"/ },
    { name: "Glob", input: { pattern: "**/*.ts" }, expectEn: /files matching \*\*\/\*\.ts/ },
    { name: "Task", input: { description: "explore" }, expectEn: /subtask/ },
    { name: "WebSearch", input: { query: "fastify docs" }, expectEn: /Searching the web for "fastify docs"/ },
    { name: "WebFetch", input: { url: "https://example.com" }, expectEn: /Fetching https:\/\/example\.com/ },
  ];

  for (const { name, input, expectEn } of searchCases) {
    test(`${name} → status searching with a bilingual template summary`, () => {
      const emissions = mapLine(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
        }),
      );
      assert.equal(emissions.length, 1);
      const status = emissions[0]!;
      assert.equal(status.type, "status");
      if (status.type === "status") {
        assert.equal(status.status, "searching");
        assert.match(status.summary.en, expectEn);
        assert.ok(status.summary.ja.length > 0, "ja copy must be present");
      }
    });
  }
});

describe("mapEventToEmissions: edit tools → editing + fileChanged", () => {
  test("Edit → modified with an old/new diff preview", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "Edit",
              input: { file_path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
            },
          ],
        },
      }),
    );
    assert.equal(emissions.length, 2);
    assert.deepEqual(emissions[0], {
      type: "status",
      status: "editing",
      summary: { en: "Editing src/a.ts", ja: "src/a.ts を編集しています" },
    });
    const file = emissions[1]!;
    assert.equal(file.type, "fileChanged");
    if (file.type === "fileChanged") {
      assert.equal(file.file.path, "src/a.ts");
      assert.equal(file.file.changeType, "modified");
      assert.equal(file.file.diffPreview, "- const x = 1;\n+ const x = 2;");
      assert.match(file.file.summary.en, /Edited src\/a\.ts/);
    }
  });

  test("Write → added with a content preview", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t3", name: "Write", input: { file_path: "README.md", content: "# hello" } },
          ],
        },
      }),
    );
    const file = emissions[1]!;
    assert.equal(file.type, "fileChanged");
    if (file.type === "fileChanged") {
      assert.equal(file.file.changeType, "added");
      assert.equal(file.file.diffPreview, "+ # hello");
      assert.match(file.file.summary.en, /Created README\.md/);
    }
  });

  test("MultiEdit → concatenated previews; NotebookEdit → modified via notebook_path", () => {
    const multi = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t4",
              name: "MultiEdit",
              input: {
                file_path: "src/b.ts",
                edits: [
                  { old_string: "a", new_string: "b" },
                  { old_string: "c", new_string: "d" },
                ],
              },
            },
          ],
        },
      }),
    );
    const multiFile = multi[1]!;
    assert.equal(multiFile.type, "fileChanged");
    if (multiFile.type === "fileChanged") {
      assert.equal(multiFile.file.diffPreview, "- a\n+ b\n- c\n+ d");
      assert.equal(multiFile.file.changeType, "modified");
    }

    const notebook = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t5",
              name: "NotebookEdit",
              input: { notebook_path: "analysis.ipynb", new_source: "print(1)" },
            },
          ],
        },
      }),
    );
    const nbFile = notebook[1]!;
    assert.equal(nbFile.type, "fileChanged");
    if (nbFile.type === "fileChanged") {
      assert.equal(nbFile.file.path, "analysis.ipynb");
      assert.equal(nbFile.file.changeType, "modified");
      assert.equal(nbFile.file.diffPreview, "+ print(1)");
    }
  });

  test("diff preview is scrubbed then truncated at ~2000 chars", () => {
    const secret = "ghp_fakeclaudefake1234567890abcdefgh";
    const hugeNew = `${secret} ${"x".repeat(DIFF_PREVIEW_MAX_CHARS + 500)}`;
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t6",
              name: "Edit",
              input: { file_path: "src/c.ts", old_string: "old", new_string: hugeNew },
            },
          ],
        },
      }),
    );
    const file = emissions[1]!;
    assert.equal(file.type, "fileChanged");
    if (file.type === "fileChanged") {
      assert.equal(file.file.diffPreview.includes(secret), false, "secret must be scrubbed before truncation");
      assert.ok(file.file.diffPreview.includes("[REDACTED_SECRET]"));
      assert.ok(file.file.diffPreview.endsWith(" [TRUNCATED]"));
      assert.ok(file.file.diffPreview.length <= DIFF_PREVIEW_MAX_CHARS + " [TRUNCATED]".length);
    }
  });
});

describe("mapEventToEmissions: Bash", () => {
  test("a non-test command → `$ command` line + editing 'Running a command…'", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t7", name: "Bash", input: { command: "ls -la" } }],
        },
      }),
    );
    assert.deepEqual(emissions[0], { type: "terminalLine", stream: "stdout", text: "$ ls -la" });
    assert.deepEqual(emissions[1], {
      type: "status",
      status: "editing",
      summary: { en: "Running a command…", ja: "コマンドを実行しています…" },
    });
  });

  test("a test-runner command → testing status + tests.started", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t8", name: "Bash", input: { command: "npm test" } }],
        },
      }),
    );
    assert.equal(emissions.length, 3);
    assert.deepEqual(emissions[0], { type: "terminalLine", stream: "stdout", text: "$ npm test" });
    const status = emissions[1]!;
    assert.equal(status.type, "status");
    if (status.type === "status") assert.equal(status.status, "testing");
    assert.equal(emissions[2]!.type, "testsStarted");
  });

  test("the Bash command line is scrubbed", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t9", name: "Bash", input: { command: "TOKEN=fake-claude-bare-token-42 npm install" } },
          ],
        },
      }),
    );
    const line = emissions[0]!;
    assert.equal(line.type, "terminalLine");
    if (line.type === "terminalLine") {
      assert.equal(line.text.includes("fake-claude-bare-token-42"), false);
      assert.ok(line.text.includes("[REDACTED_SECRET]"));
    }
  });
});

describe("isTestCommand", () => {
  const positives = [
    "npm test",
    "npm run test:unit",
    "npx vitest run",
    "npx jest --ci",
    "pytest tests/",
    "go test ./...",
    "cargo test",
    "xcodebuild -project X.xcodeproj -scheme X test",
  ];
  const negatives = ["npm install", "ls -la", "git status", "node script.js", "echo test-drive"];

  for (const cmd of positives) {
    test(`detects: ${cmd}`, () => assert.equal(isTestCommand(cmd), true));
  }
  for (const cmd of negatives) {
    test(`ignores: ${cmd}`, () => assert.equal(isTestCommand(cmd), false));
  }
});

describe("mapEventToEmissions: tool_result", () => {
  function bashTestContext(): ReturnType<typeof ctx> {
    const context = ctx();
    // Register the pending test command exactly like the Bash mapping does.
    mapLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_test", name: "Bash", input: { command: "npm test" } }],
        },
      }),
      context,
    );
    return context;
  }

  test("a plain tool_result becomes compact snippet lines (first ~6, each capped)", () => {
    const longLine = "y".repeat(400);
    const text = ["l1", "l2", "l3", "l4", "l5", longLine, "l7", "l8"].join("\n");
    const emissions = mapLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_x", content: [{ type: "text", text }] }],
        },
      }),
    );
    // 6 snippet lines + 1 "+N more lines" marker.
    assert.equal(emissions.length, 7);
    for (const emission of emissions) assert.equal(emission.type, "terminalLine");
    const capped = emissions[5]!;
    if (capped.type === "terminalLine") {
      assert.ok(capped.text.endsWith(" [TRUNCATED]"), "long snippet lines must be capped");
      assert.ok(capped.text.length <= 200 + " [TRUNCATED]".length);
    }
    const more = emissions[6]!;
    if (more.type === "terminalLine") assert.equal(more.text, "… (+2 more lines)");
  });

  test("an error tool_result's snippet goes to stderr", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: "command failed" }],
        },
      }),
    );
    const line = emissions[0]!;
    assert.equal(line.type, "terminalLine");
    if (line.type === "terminalLine") assert.equal(line.stream, "stderr");
  });

  test("a test command's result with a vitest-style summary → tests.finished with counts", () => {
    const context = bashTestContext();
    const emissions = mapLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_test",
              is_error: false,
              content: [{ type: "text", text: "Tests  12 passed | 1 failed\nDuration: in 3.2s" }],
            },
          ],
        },
      }),
      context,
    );
    const finished = emissions.find((e) => e.type === "testsFinished");
    assert.ok(finished, "expected a testsFinished emission");
    if (finished?.type === "testsFinished") {
      assert.equal(finished.result.status, "passed");
      assert.equal(finished.result.passedCount, 12);
      assert.equal(finished.result.failedCount, 1);
      assert.equal(finished.result.durationSeconds, 3.2);
      assert.match(finished.result.summary.en, /12 passed, 1 failed/);
    }
    // Correlation is one-shot: a second result for the same id is plain output.
    assert.equal(context.pendingTestToolUseIds.has("toolu_test"), false);
  });

  test("a failing test result without parseable counts → honest 'counts unavailable' summary", () => {
    const context = bashTestContext();
    const emissions = mapLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_test",
              is_error: true,
              content: [{ type: "text", text: "something exploded, no summary here" }],
            },
          ],
        },
      }),
      context,
    );
    const finished = emissions.find((e) => e.type === "testsFinished");
    assert.ok(finished);
    if (finished?.type === "testsFinished") {
      assert.equal(finished.result.status, "failed");
      assert.equal(finished.result.passedCount, 0);
      assert.equal(finished.result.failedCount, 0);
      assert.match(finished.result.summary.en, /counts unavailable/);
      assert.match(finished.result.summary.ja, /件数は取得できませんでした/);
    }
  });

  test("tool_result snippets are scrubbed", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: [{ type: "text", text: "loaded ANTHROPIC_API_KEY=sk-ant-api03-fakeclaudefake1234" }],
            },
          ],
        },
      }),
    );
    const line = emissions[0]!;
    assert.equal(line.type, "terminalLine");
    if (line.type === "terminalLine") {
      assert.equal(line.text.includes("sk-ant-api03-fakeclaudefake1234"), false);
      assert.ok(line.text.includes("[REDACTED_SECRET]"));
    }
  });
});

describe("extractTestCounts", () => {
  test("vitest/jest/pytest style summaries", () => {
    assert.deepEqual(extractTestCounts("Tests: 3 failed, 11 passed"), {
      passed: 11,
      failed: 3,
      durationSeconds: null,
    });
    assert.deepEqual(extractTestCounts("== 5 passed in 1.4s =="), { passed: 5, failed: null, durationSeconds: 1.4 });
    assert.deepEqual(extractTestCounts("no summary at all"), { passed: null, failed: null, durationSeconds: null });
  });
});

describe("mapEventToEmissions: result", () => {
  test("success → idle 'waiting' status + the turn-finished line with tokens/cost", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0.0345,
        usage: { input_tokens: 120, output_tokens: 456 },
      }),
    );
    assert.deepEqual(emissions[0], { type: "status", status: "idle", summary: WAITING_FOR_MESSAGE_SUMMARY });
    assert.deepEqual(emissions[1], {
      type: "terminalLine",
      stream: "stdout",
      text: "[orbitory] turn finished (tokens 120/456, cost $0.0345)",
    });
  });

  test("error → sessionFailed with a scrubbed reason", () => {
    const emissions = mapLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "crashed while holding TOKEN=fake-claude-bare-token-42",
      }),
    );
    assert.equal(emissions.length, 1);
    const failed = emissions[0]!;
    assert.equal(failed.type, "sessionFailed");
    if (failed.type === "sessionFailed") {
      assert.equal(failed.reason.en.includes("fake-claude-bare-token-42"), false);
      assert.ok(failed.reason.en.includes("[REDACTED_SECRET]"));
      assert.ok(failed.reason.ja.length > 0);
    }
  });

  test("the two spike-captured auth strings produce the dedicated login copy", () => {
    for (const text of [
      "Not logged in · Please run /login",
      "Failed to authenticate. API Error: 401 …",
    ]) {
      assert.equal(isAuthFailureText(text), true, `should detect: ${text}`);
      const emissions = mapLine(
        JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text }),
      );
      const failed = emissions[0]!;
      assert.equal(failed.type, "sessionFailed");
      if (failed.type === "sessionFailed") {
        assert.deepEqual(failed.reason, AUTH_FAILURE_REASON);
        assert.match(failed.reason.en, /run `claude` once/);
        assert.match(failed.reason.ja, /ログイン/);
      }
    }
    assert.equal(isAuthFailureText("everything is fine"), false);
  });
});

describe("mapEventToEmissions: unparseable passthrough", () => {
  test("a raw non-JSON line is forwarded as a scrubbed plain terminal line", () => {
    const emissions = mapLine("warning: OPENAI_KEY=sk-fakeclaudestderr1234567890 leaked");
    assert.equal(emissions.length, 1);
    const line = emissions[0]!;
    assert.equal(line.type, "terminalLine");
    if (line.type === "terminalLine") {
      assert.equal(line.stream, "stdout");
      assert.equal(line.text.includes("sk-fakeclaudestderr1234567890"), false);
      assert.ok(line.text.includes("[REDACTED_SECRET]"));
      assert.ok(line.text.startsWith("warning: "));
    }
  });
});
