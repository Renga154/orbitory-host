/** Pure command and JSONL parsing helpers for Codex exec turns. */

import type { AgentStatus, Localized } from "../types.js";
import type { ResolvedProviderSelection } from "../providerControls.js";

const STALE_RESUME_REASON: Localized = {
  en: "This saved Codex session is no longer available. Refresh the project list and start a new session.",
  ja: "この Codex セッションの履歴は利用できなくなりました。プロジェクト一覧を更新し、新しいセッションを開始してください。",
};

const CODEX_STATE_REASON: Localized = {
  en: "Codex could not open its local state. Restart the Orbitory host with the latest package and try again.",
  ja: "Codex のローカル状態を開けませんでした。最新版の Orbitory ホストを再起動して、もう一度お試しください。",
};

const CODEX_AUTH_REASON: Localized = {
  en: "Codex is not authenticated on this computer. Run `codex login` on the computer, then try again.",
  ja: "このコンピュータで Codex にログインしていません。コンピュータで `codex login` を実行してから、もう一度お試しください。",
};

/** Map private CLI diagnostics to bounded, path-free bilingual guidance. */
export function classifyCodexFailureText(text: string): Localized | undefined {
  if (/thread\/resume failed|no rollout found for thread id/iu.test(text)) {
    return { ...STALE_RESUME_REASON };
  }
  if (/failed to initialize in-process app-server client|operation not permitted/iu.test(text)) {
    return { ...CODEX_STATE_REASON };
  }
  if (/not logged in|authentication required|unauthorized|codex login/iu.test(text)) {
    return { ...CODEX_AUTH_REASON };
  }
  return undefined;
}

function operatorExecArgs(args: readonly string[]): string[] {
  return args[0] === "exec" ? args.slice(1) : [...args];
}

/** Build argv for a fresh or resumed Codex exec JSONL turn. */
export function buildCodexExecArgv(
  config: { args: readonly string[] },
  threadId?: string,
  selection?: ResolvedProviderSelection,
): string[] {
  const extras = operatorExecArgs(config.args);
  const selectedArgs = [
    ...(selection?.modelCliValue ? ["--model", selection.modelCliValue] : []),
    ...(selection?.intent === "plan" || selection?.intent === "review"
      ? ["-c", 'sandbox_mode="read-only"']
      : []),
  ];
  return threadId === undefined
    ? ["exec", ...extras, ...selectedArgs, "--skip-git-repo-check", "--json", "-"]
    : [
        "exec",
        "resume",
        ...extras,
        ...selectedArgs,
        "--skip-git-repo-check",
        "--json",
        threadId,
        "-",
      ];
}

export type CodexExecEvent =
  | { kind: "threadStarted"; threadId: string }
  | { kind: "turnStarted" }
  | { kind: "turnCompleted" }
  | { kind: "turnFailed"; message: string }
  | { kind: "processError"; message: string }
  | { kind: "assistantMessage"; text: string }
  | { kind: "status"; status: AgentStatus; summary: Localized }
  | { kind: "ignored" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ITEM_STATUS: Readonly<
  Record<string, { status: AgentStatus; summary: Localized }>
> = {
  command_execution: {
    status: "editing",
    summary: {
      en: "Codex is running a command.",
      ja: "Codex がコマンドを実行しています。",
    },
  },
  reasoning: {
    status: "planning",
    summary: { en: "Codex is reasoning.", ja: "Codex が検討しています。" },
  },
  file_change: {
    status: "editing",
    summary: {
      en: "Codex is applying file changes.",
      ja: "Codex がファイルの変更を適用しています。",
    },
  },
  mcp_tool_call: {
    status: "editing",
    summary: { en: "Codex is using a tool.", ja: "Codex がツールを使用しています。" },
  },
  web_search: {
    status: "searching",
    summary: { en: "Codex is searching the web.", ja: "Codex がウェブを検索しています。" },
  },
  todo_list: {
    status: "planning",
    summary: { en: "Codex updated its plan.", ja: "Codex が計画を更新しました。" },
  },
};

/** Parse one public `codex exec --json` JSONL event without throwing. */
export function parseCodexExecLine(line: string): CodexExecEvent {
  try {
    const value = JSON.parse(line) as unknown;
    const event = asRecord(value);
    if (event) {
      if (event["type"] === "thread.started" && typeof event["thread_id"] === "string") {
        return { kind: "threadStarted", threadId: event["thread_id"] };
      }
      if (event["type"] === "turn.started") {
        return { kind: "turnStarted" };
      }
      if (event["type"] === "turn.completed") {
        return { kind: "turnCompleted" };
      }
      if (event["type"] === "turn.failed") {
        const error = asRecord(event["error"]);
        return {
          kind: "turnFailed",
          message:
            typeof error?.["message"] === "string"
              ? error["message"]
              : typeof event["message"] === "string"
                ? event["message"]
                : "",
        };
      }
      if (event["type"] === "error") {
        return {
          kind: "processError",
          message: typeof event["message"] === "string" ? event["message"] : "",
        };
      }
      const item = asRecord(event["item"]);
      if (
        event["type"] === "item.completed" &&
        item?.["type"] === "agent_message" &&
        typeof item["text"] === "string"
      ) {
        return { kind: "assistantMessage", text: item["text"] };
      }
      if (
        (event["type"] === "item.started" ||
          event["type"] === "item.updated" ||
          event["type"] === "item.completed") &&
        typeof item?.["type"] === "string"
      ) {
        const mapped = ITEM_STATUS[item["type"]];
        if (mapped) {
          return { kind: "status", status: mapped.status, summary: mapped.summary };
        }
      }
    }
  } catch {
    // Unknown and malformed lines are deliberately consumed, never forwarded raw.
  }
  return { kind: "ignored" };
}
