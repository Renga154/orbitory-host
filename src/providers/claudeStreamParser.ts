/**
 * Pure parser + protocol mapper for Claude Code's `--output-format stream-json`
 * events (Phase 16 — see `docs/PHASE16_REAL_AGENT_INTEGRATION.md` §4.2).
 *
 * This module is deliberately free of I/O and process state so every mapping
 * row is directly unit-testable (`tests/claude-stream-parser.test.ts`):
 *
 * - `buildClaudeArgv` — the host-authoritative argv appended to the operator's
 *   own `args` (the client can never influence any of this).
 * - `parseClaudeStreamLine` — one stdout line → one typed `ClaudeStreamEvent`.
 *   Lenient by design: anything that isn't recognizable, well-formed
 *   stream-json parses as `{ kind: "unparseable" }` and is forwarded to the
 *   client as a plain (scrubbed) terminal line — never swallowed, never a
 *   crash. The stream schema is Anthropic's, not ours; it may drift.
 * - `mapEventToEmissions` — one event → zero or more provider-agnostic
 *   `StreamEmission`s implementing the §4.2 mapping table. The provider
 *   (`ClaudeCodeStreamProvider`) turns emissions into protocol envelopes.
 *
 * ## Scrubbing boundary (CLAUDE.md invariant)
 *
 * Raw stream-json lines routinely exceed the terminal line cap and scrubbing
 * would mangle JSON before parsing, so — per the Phase 16 plan — the scrub
 * boundary is the DERIVED STRING: every piece of process-derived text that
 * enters an emission (chat text, command lines, paths, diff previews, result
 * snippets, error reasons, model/session ids) passes through `ctx.scrub`
 * inside `mapEventToEmissions` before it is placed in an emission. The
 * provider supplies `scrubSecrets` (plus its literal pairing-token rule) as
 * `ctx.scrub`. Host-authored template copy is bilingual `{en, ja}`; only the
 * technical interpolations (paths/commands — protocol §9 bucket 3) and chat
 * text are process-derived.
 */

import type { AgentStatus, ChangedFile, Localized, TerminalStream, TestResult } from "../types.js";

// ---------------------------------------------------------------------------
// argv builder
// ---------------------------------------------------------------------------

/** The MCP tool name Claude Code calls for permission prompts (Mechanism A). */
export const APPROVAL_PROMPT_TOOL_NAME = "mcp__orbitory__approval_prompt";

/**
 * Build the full argv for a stream-json Claude Code session. Fixed, documented
 * order:
 *
 *   1. The operator's own `config.args` first (extras like `--model`,
 *      `--allowedTools` — host-configured, never client-supplied).
 *   2. The host-authoritative stream flags:
 *      `-p --output-format stream-json --input-format stream-json
 *       --include-partial-messages --session-id <uuid>`.
 *   3. When an approval bridge is wired (Mechanism A):
 *      `--permission-prompt-tool <toolName> --mcp-config <path>
 *       --strict-mcp-config`.
 *
 * Pure and exported for argv-exact tests.
 */
export function buildClaudeArgv(
  config: { args: string[] },
  sessionUuid: string,
  bridge?: { toolName: string; mcpConfigPath: string },
): string[] {
  const argv = [
    ...config.args,
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--session-id",
    sessionUuid,
  ];
  if (bridge) {
    argv.push(
      "--permission-prompt-tool",
      bridge.toolName,
      "--mcp-config",
      bridge.mcpConfigPath,
      "--strict-mcp-config",
    );
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Line → event parsing
// ---------------------------------------------------------------------------

/** One content block of a complete assistant turn. */
export type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string | undefined; name: string; input: Record<string, unknown> };

/** One `tool_result` block carried by a `user` event. */
export interface ToolResultBlock {
  toolUseId: string | undefined;
  text: string;
  isError: boolean;
}

/**
 * A single parsed stream-json event, reduced to exactly what the §4.2 mapping
 * needs. `partial` covers `--include-partial-messages` deltas
 * (`stream_event`), which are deliberately ignored — the complete `assistant`
 * turn follows and is the one that becomes a chat message.
 */
export type ClaudeStreamEvent =
  | { kind: "systemInit"; claudeSessionId: string; model: string }
  | { kind: "systemOther" }
  | { kind: "assistant"; blocks: AssistantContentBlock[] }
  | { kind: "partial" }
  | { kind: "toolResult"; results: ToolResultBlock[] }
  | { kind: "userOther" }
  | {
      kind: "result";
      isError: boolean;
      resultText: string;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
    }
  | { kind: "unparseable"; line: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Flatten a tool_result `content` (string, or array of text blocks) to text. */
function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      if (rec && rec["type"] === "text" && typeof rec["text"] === "string") {
        parts.push(rec["text"]);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Parse one stdout line into a `ClaudeStreamEvent`. Pure; never throws.
 * Anything unrecognized — non-JSON, non-object JSON, an unknown `type`, or a
 * known type whose payload is malformed — is `{ kind: "unparseable" }` so the
 * caller forwards it as plain scrubbed terminal output rather than losing it.
 */
export function parseClaudeStreamLine(line: string): ClaudeStreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unparseable", line };
  }
  const event = asRecord(parsed);
  if (!event || typeof event["type"] !== "string") {
    return { kind: "unparseable", line };
  }

  switch (event["type"]) {
    case "system": {
      if (event["subtype"] === "init") {
        return {
          kind: "systemInit",
          claudeSessionId: asString(event["session_id"]),
          model: asString(event["model"]),
        };
      }
      return { kind: "systemOther" };
    }

    case "stream_event":
      // Partial message deltas (--include-partial-messages). Ignored: the
      // complete `assistant` event that follows carries the final text.
      return { kind: "partial" };

    case "assistant": {
      const message = asRecord(event["message"]);
      const content = message?.["content"];
      const blocks: AssistantContentBlock[] = [];
      if (typeof content === "string") {
        blocks.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item);
          if (!rec) continue;
          if (rec["type"] === "text" && typeof rec["text"] === "string") {
            blocks.push({ type: "text", text: rec["text"] });
          } else if (rec["type"] === "tool_use" && typeof rec["name"] === "string") {
            blocks.push({
              type: "toolUse",
              id: typeof rec["id"] === "string" ? rec["id"] : undefined,
              name: rec["name"],
              input: asRecord(rec["input"]) ?? {},
            });
          }
        }
      }
      return { kind: "assistant", blocks };
    }

    case "user": {
      const message = asRecord(event["message"]);
      const content = message?.["content"];
      const results: ToolResultBlock[] = [];
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item);
          if (rec && rec["type"] === "tool_result") {
            results.push({
              toolUseId: typeof rec["tool_use_id"] === "string" ? rec["tool_use_id"] : undefined,
              text: toolResultContentToText(rec["content"]),
              isError: rec["is_error"] === true,
            });
          }
        }
      }
      // A `user` event with no tool_result blocks is the CLI echoing user
      // input back — the client already has that message; ignore it.
      return results.length > 0 ? { kind: "toolResult", results } : { kind: "userOther" };
    }

    case "result": {
      const usage = asRecord(event["usage"]);
      const subtype = asString(event["subtype"]);
      return {
        kind: "result",
        // The spike (§6 S1) showed auth failures arrive as subtype "success"
        // with `is_error: true`, so both signals are honored.
        isError: event["is_error"] === true || subtype.startsWith("error"),
        resultText: asString(event["result"]),
        inputTokens: asNumberOrNull(usage?.["input_tokens"]),
        outputTokens: asNumberOrNull(usage?.["output_tokens"]),
        costUsd: asNumberOrNull(event["total_cost_usd"]),
      };
    }

    default:
      return { kind: "unparseable", line };
  }
}

// ---------------------------------------------------------------------------
// Event → emissions mapping (§4.2)
// ---------------------------------------------------------------------------

/**
 * A provider-agnostic instruction derived from one stream event. The provider
 * translates each emission into the matching protocol envelope(s) and session
 * bookkeeping. Every process-derived string inside an emission has already
 * been through `ctx.scrub`.
 */
export type StreamEmission =
  | { type: "status"; status: AgentStatus; summary: Localized }
  | { type: "chat"; role: "assistant"; text: string }
  | { type: "terminalLine"; stream: TerminalStream; text: string }
  | { type: "fileChanged"; file: ChangedFile }
  | { type: "testsStarted"; summary: Localized }
  | { type: "testsFinished"; result: TestResult }
  | { type: "sessionFailed"; reason: Localized };

/**
 * Per-session mapping state. Deterministic and test-constructable via
 * `createStreamMapContext`; the only mutation is the pending-test-command set
 * that correlates a Bash `tool_use` with its later `tool_result`.
 */
export interface StreamMapContext {
  /** Scrubs process-derived text (the provider passes `scrubSecrets` + its pairing-token literal). */
  scrub: (text: string) => string;
  /** `tool_use` ids of Bash test-runner commands still awaiting a `tool_result`. */
  pendingTestToolUseIds: Set<string>;
}

export function createStreamMapContext(scrub: (text: string) => string): StreamMapContext {
  return { scrub, pendingTestToolUseIds: new Set() };
}

/** Tools that read/search — mapped to status `searching`. */
const SEARCH_TOOLS = new Set(["Read", "Grep", "Glob", "Task", "WebSearch", "WebFetch"]);

/** Tools that write files — mapped to status `editing` + a `diff.updated` entry. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Test-runner command patterns (the §4.2 Bash → `testing`/`tests.started`
 * heuristic). Exported for direct unit testing.
 */
export const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+test\b/,
  /\bnpm\s+run\s+test/,
  /\bnpx\s+vitest\b/,
  /\bnpx\s+jest\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bxcodebuild\b[^\n]*\btest\b/,
];

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some((p) => p.test(command));
}

/** Max characters of a derived diff preview (spec §4.2: "truncated ~2000 chars"). */
export const DIFF_PREVIEW_MAX_CHARS = 2_000;

/** Max characters of a short interpolation (path/pattern/query) inside a summary. */
const SUMMARY_TARGET_MAX_CHARS = 120;

/** tool_result snippet shape: first N lines, each capped. */
const RESULT_SNIPPET_MAX_LINES = 6;
const RESULT_SNIPPET_LINE_MAX_CHARS = 200;

/** Marker appended to text the mapper itself truncated (scrub first, truncate second). */
const TRUNCATED_MARKER = " [TRUNCATED]";

function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + TRUNCATED_MARKER : text;
}

/** Bilingual copy for a session waiting for the user's next message (status `idle`). */
export const WAITING_FOR_MESSAGE_SUMMARY: Localized = {
  en: "Waiting for your next message.",
  ja: "次のメッセージを待っています。",
};

/**
 * Dedicated bilingual failure copy for the two auth failure strings captured
 * in the spike (§6 S1): the fix is a one-time `claude` login on the host.
 */
export const AUTH_FAILURE_REASON: Localized = {
  en:
    "Claude Code is not logged in on this host. Open a terminal on the host machine, " +
    "run `claude` once and log in, then start a new session.",
  ja:
    "このホストでは Claude Code にログインしていません。ホストマシンのターミナルで一度 `claude` を実行して" +
    "ログインしてから、新しいセッションを開始してください。",
};

/** The exact auth-failure substrings captured from the real CLI (spike §6 S1). */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [/Not logged in/i, /Failed to authenticate/i];

export function isAuthFailureText(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((p) => p.test(text));
}

/** Bilingual per-tool `searching` summaries (host-authored templates; interpolations scrubbed). */
function searchSummary(toolName: string, target: string): Localized {
  switch (toolName) {
    case "Read":
      return { en: `Reading ${target}`, ja: `${target} を読んでいます` };
    case "Grep":
      return { en: `Searching the code for "${target}"`, ja: `コードから「${target}」を検索しています` };
    case "Glob":
      return { en: `Looking for files matching ${target}`, ja: `${target} に一致するファイルを探しています` };
    case "Task":
      return { en: "Working on a subtask", ja: "サブタスクを実行しています" };
    case "WebSearch":
      return { en: `Searching the web for "${target}"`, ja: `ウェブで「${target}」を検索しています` };
    case "WebFetch":
      return { en: `Fetching ${target}`, ja: `${target} を取得しています` };
    default:
      return { en: `Using ${toolName}`, ja: `${toolName} を使用しています` };
  }
}

/** The most descriptive short string a search tool's input offers. */
function searchTarget(input: Record<string, unknown>): string {
  for (const key of ["file_path", "pattern", "query", "url", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * changeType heuristic (§4.2): `Write` creates/replaces a whole file → `added`;
 * the granular edit tools modify an existing one → `modified`. Pure guess —
 * the parser has no filesystem access by design (`deleted` is never derivable
 * from tool input alone).
 */
function changeTypeForTool(toolName: string): ChangedFile["changeType"] {
  return toolName === "Write" ? "added" : "modified";
}

/** Build a scrubbed, capped diff preview from an edit tool's input. */
function diffPreviewForTool(
  toolName: string,
  input: Record<string, unknown>,
  scrub: (text: string) => string,
): string {
  let raw = "";
  if (toolName === "Edit") {
    raw = `- ${asString(input["old_string"])}\n+ ${asString(input["new_string"])}`;
  } else if (toolName === "MultiEdit") {
    const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
    const parts: string[] = [];
    for (const edit of edits) {
      const rec = asRecord(edit);
      if (rec) parts.push(`- ${asString(rec["old_string"])}\n+ ${asString(rec["new_string"])}`);
    }
    raw = parts.join("\n");
  } else if (toolName === "Write") {
    raw = `+ ${asString(input["content"])}`;
  } else if (toolName === "NotebookEdit") {
    raw = `+ ${asString(input["new_source"])}`;
  }
  // Scrub FIRST, truncate SECOND — truncating first could bisect a secret so
  // its pattern no longer matches (same invariant as TerminalAgentProvider).
  return capText(scrub(raw), DIFF_PREVIEW_MAX_CHARS);
}

function mapToolUse(
  block: Extract<AssistantContentBlock, { type: "toolUse" }>,
  ctx: StreamMapContext,
): StreamEmission[] {
  const { name, input } = block;

  if (SEARCH_TOOLS.has(name)) {
    const target = capText(ctx.scrub(searchTarget(input)), SUMMARY_TARGET_MAX_CHARS);
    return [{ type: "status", status: "searching", summary: searchSummary(name, target) }];
  }

  if (EDIT_TOOLS.has(name)) {
    const rawPath = asString(input["file_path"]) || asString(input["notebook_path"]) || "(unknown file)";
    const path = capText(ctx.scrub(rawPath), SUMMARY_TARGET_MAX_CHARS);
    const changeType = changeTypeForTool(name);
    const file: ChangedFile = {
      path,
      changeType,
      summary:
        changeType === "added"
          ? { en: `Created ${path}.`, ja: `${path} を作成しました。` }
          : { en: `Edited ${path}.`, ja: `${path} を編集しました。` },
      diffPreview: diffPreviewForTool(name, input, ctx.scrub),
    };
    return [
      { type: "status", status: "editing", summary: { en: `Editing ${path}`, ja: `${path} を編集しています` } },
      { type: "fileChanged", file },
    ];
  }

  if (name === "Bash") {
    const command = ctx.scrub(asString(input["command"]));
    const emissions: StreamEmission[] = [
      { type: "terminalLine", stream: "stdout", text: `$ ${command}` },
    ];
    if (isTestCommand(command)) {
      if (block.id !== undefined) {
        ctx.pendingTestToolUseIds.add(block.id);
      }
      emissions.push(
        { type: "status", status: "testing", summary: { en: "Running the test suite.", ja: "テストスイートを実行しています。" } },
        {
          type: "testsStarted",
          summary: { en: "Running test suite...", ja: "テストスイートを実行中です..." },
        },
      );
    } else {
      emissions.push({
        type: "status",
        status: "editing",
        summary: { en: "Running a command…", ja: "コマンドを実行しています…" },
      });
    }
    return emissions;
  }

  // Tools outside the §4.2 table (TodoWrite, MCP tools, …): no status/summary
  // mapping is defined for them; their effects surface via later events (tool
  // results, edits, approvals). Deliberately no emission.
  return [];
}

/**
 * Opportunistic test-count extraction from a test runner's output
 * (vitest/jest/pytest style "N passed"/"N failed"). Returns nulls when no
 * recognizable summary is present — the caller then reports counts honestly
 * as unavailable instead of inventing zeros that look authoritative.
 */
export function extractTestCounts(text: string): {
  passed: number | null;
  failed: number | null;
  durationSeconds: number | null;
} {
  const passedMatch = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(text);
  const failedMatch = /(\d+)\s+fail(?:ed|ing)?\b/i.exec(text);
  const durationMatch = /\bin\s+([\d.]+)\s*s\b/i.exec(text);
  return {
    passed: passedMatch?.[1] !== undefined ? Number(passedMatch[1]) : null,
    failed: failedMatch?.[1] !== undefined ? Number(failedMatch[1]) : null,
    durationSeconds: durationMatch?.[1] !== undefined ? Number(durationMatch[1]) : null,
  };
}

function mapToolResult(block: ToolResultBlock, ctx: StreamMapContext): StreamEmission[] {
  const emissions: StreamEmission[] = [];
  const scrubbed = ctx.scrub(block.text);
  const stream: TerminalStream = block.isError ? "stderr" : "stdout";

  // Compact snippet: first few lines, each capped — enough to follow along in
  // Live without flooding the phone with a whole file/test log.
  const lines = scrubbed.split("\n");
  for (const line of lines.slice(0, RESULT_SNIPPET_MAX_LINES)) {
    emissions.push({ type: "terminalLine", stream, text: capText(line, RESULT_SNIPPET_LINE_MAX_CHARS) });
  }
  if (lines.length > RESULT_SNIPPET_MAX_LINES) {
    emissions.push({
      type: "terminalLine",
      stream,
      text: `… (+${lines.length - RESULT_SNIPPET_MAX_LINES} more lines)`,
    });
  }

  // If this result answers a Bash test command, finish the test run.
  if (block.toolUseId !== undefined && ctx.pendingTestToolUseIds.has(block.toolUseId)) {
    ctx.pendingTestToolUseIds.delete(block.toolUseId);
    const status = block.isError ? "failed" : "passed";
    const counts = extractTestCounts(scrubbed);
    const haveCounts = counts.passed !== null || counts.failed !== null;
    const passedCount = counts.passed ?? 0;
    const failedCount = counts.failed ?? 0;
    const result: TestResult = {
      status,
      passedCount: haveCounts ? passedCount : 0,
      failedCount: haveCounts ? failedCount : 0,
      durationSeconds: counts.durationSeconds ?? 0,
      summary: haveCounts
        ? {
            en: `${passedCount} passed, ${failedCount} failed.`,
            ja: `${passedCount}件成功、${failedCount}件失敗。`,
          }
        : {
            // Honest: the run finished but its output had no recognizable
            // count summary — never invent counts.
            en: `Tests finished (${status}); detailed counts unavailable.`,
            ja: `テストが完了しました（${status === "passed" ? "成功" : "失敗"}）。詳細な件数は取得できませんでした。`,
          },
    };
    emissions.push({ type: "testsFinished", result });
  }

  return emissions;
}

/** Reason-text cap for `session.failed` reasons derived from a result event. */
const FAILURE_REASON_MAX_CHARS = 500;

/**
 * Map one parsed event onto zero or more emissions per the §4.2 table.
 * `ctx` carries the scrub function and the pending-test-command correlation
 * set; everything else is stateless.
 */
export function mapEventToEmissions(event: ClaudeStreamEvent, ctx: StreamMapContext): StreamEmission[] {
  switch (event.kind) {
    case "systemInit": {
      const id = ctx.scrub(event.claudeSessionId) || "(unknown)";
      const model = ctx.scrub(event.model) || "(unknown)";
      return [
        {
          type: "status",
          status: "planning",
          summary: {
            en: "Claude Code session started.",
            ja: "Claude Code セッションを開始しました。",
          },
        },
        { type: "terminalLine", stream: "stdout", text: `[orbitory] claude session ${id} (model ${model})` },
      ];
    }

    case "assistant": {
      const emissions: StreamEmission[] = [];
      for (const block of event.blocks) {
        if (block.type === "text") {
          const text = ctx.scrub(block.text);
          if (text.trim().length > 0) {
            emissions.push({ type: "chat", role: "assistant", text });
          }
        } else {
          emissions.push(...mapToolUse(block, ctx));
        }
      }
      return emissions;
    }

    case "toolResult": {
      const emissions: StreamEmission[] = [];
      for (const block of event.results) {
        emissions.push(...mapToolResult(block, ctx));
      }
      return emissions;
    }

    case "result": {
      if (event.isError) {
        const scrubbed = capText(ctx.scrub(event.resultText), FAILURE_REASON_MAX_CHARS);
        const reason: Localized = isAuthFailureText(event.resultText)
          ? AUTH_FAILURE_REASON
          : {
              en: `Claude Code reported an error: ${scrubbed}`,
              ja: `Claude Code がエラーを報告しました: ${scrubbed}`,
            };
        return [{ type: "sessionFailed", reason }];
      }
      // Turn finished successfully. The session is NOT over — the process
      // stays alive for the next stdin message. `AgentStatus` already has
      // "idle" ("steady/waiting" per docs/protocol.md §5), which is exactly
      // the §4.2 intent ("waiting for your next message"), so no turnFinished
      // marker indirection is needed.
      const tokens = `${event.inputTokens ?? 0}/${event.outputTokens ?? 0}`;
      const cost = (event.costUsd ?? 0).toFixed(4);
      return [
        { type: "status", status: "idle", summary: WAITING_FOR_MESSAGE_SUMMARY },
        {
          type: "terminalLine",
          stream: "stdout",
          text: `[orbitory] turn finished (tokens ${tokens}, cost $${cost})`,
        },
      ];
    }

    case "unparseable":
      // Raw passthrough: scrubbed here (the derived-string boundary), capped
      // by the provider's normal terminal-line limit on emit.
      return [{ type: "terminalLine", stream: "stdout", text: ctx.scrub(event.line) }];

    case "systemOther":
    case "partial":
    case "userOther":
      return [];
  }
}
