/**
 * Agent presentation presets for terminal-backed sessions.
 *
 * This is the entire "Claude Code adapter" surface for Phase 4 — and it is
 * deliberately thin: **presentation only, no output parsing.** A real coding
 * agent CLI (Claude Code, Codex, …) does not emit a stable, documented,
 * machine-readable status format, so `TerminalAgentProvider` never tries to
 * interpret what such a process prints. Instead it drives a generic terminal
 * lifecycle (planning on spawn → editing on first output → completed on exit
 * 0 / failed otherwise) and asks this module only for the *bilingual copy* to
 * attach to those transitions, keyed by the session's host-authoritative
 * `agentType`.
 *
 * So a `claudeCode` session reads "Claude Code is working…" instead of a raw
 * display name, without any Claude-Code-specific parsing logic existing
 * anywhere. Adding another CLI later (e.g. Codex) is a one-line brand entry
 * here plus an example config entry — no new execution path.
 */

import type { AgentType, Localized } from "../types.js";

/** Bilingual status copy for the three generic terminal-lifecycle transitions. */
export interface AgentPresetCopy {
  /** `planning` — the process has just been spawned. */
  starting: Localized;
  /** `editing` — the process produced its first output; it's actively doing work. */
  running: Localized;
  /** `completed` — the process exited 0. */
  completed: Localized;
}

/**
 * Human brand label per known coding-agent CLI. `custom` (and anything not
 * listed) falls back to the config's own `displayName`, preserving the
 * pre-Phase-4 behavior for the demo terminal agent exactly.
 */
const BRAND_LABEL: Partial<Record<AgentType, string>> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  geminiCli: "Gemini CLI",
  aider: "Aider",
  openCode: "OpenCode",
};

/** The label to show for a session of this `agentType`, falling back to `displayName`. */
export function presetLabel(agentType: AgentType, displayName: string): string {
  return BRAND_LABEL[agentType] ?? displayName;
}

/**
 * Bilingual copy for a terminal-backed session's generic lifecycle
 * transitions. `claudeCode` (and other branded CLIs) get agent-branded copy;
 * `custom` gets the display-name-based copy that matches the original
 * `TerminalAgentProvider` behavior, so the demo terminal agent is unchanged.
 */
export function presetCopy(agentType: AgentType, displayName: string): AgentPresetCopy {
  const label = presetLabel(agentType, displayName);

  if (agentType !== "custom") {
    return {
      starting: { en: `Starting ${label}…`, ja: `${label} を起動しています…` },
      running: { en: `${label} is working…`, ja: `${label} が作業しています…` },
      completed: { en: `${label} finished.`, ja: `${label} が完了しました。` },
    };
  }

  // Generic (custom) copy — byte-for-byte the strings TerminalAgentProvider
  // used before presets existed.
  return {
    starting: { en: `Starting ${label}…`, ja: `${label} を起動しています…` },
    running: { en: `${label} is running.`, ja: `${label} を実行中です。` },
    completed: { en: `${label} finished successfully.`, ja: `${label} が正常に完了しました。` },
  };
}

/**
 * The canonical, disabled-by-default Claude Code example entry. Single source
 * of truth for `orbitory.config.example.json`, the docs, and the test that
 * asserts the example file stays in sync. Intentionally `enabled: false` and
 * pointed at a non-existent sibling directory so it is inert until a host
 * operator points it at a real disposable project and flips `enabled`.
 *
 * `command: "claude"` and `args: []` are the documented, conservative
 * invocation; if a future Claude Code version needs specific flags, they go
 * in `args` here (and in the operator's own config), never supplied by the
 * client. See docs/PHASE4_CLAUDE_CODE_ADAPTER.md.
 *
 * Phase 4.5 gave it `sandbox.required: true`; Phase 5.5 moved it to
 * `mode: "container"` — the first mode that also confines READS and adds
 * memory/CPU/pids limits, i.e. the isolation a real CLI actually needs. The
 * image is an operator-built placeholder (there is no official
 * Claude-Code-in-a-box image; see docs/PHASE5_5_CONTAINER_SANDBOX.md for what
 * such an image must contain), `envAllowlist` is credentials-only (the
 * container gets the image's own PATH/HOME, not the host's), and
 * `allowNetwork` stays `false` — the fail-safe default an operator must
 * consciously flip for a real run, since a real CLI needs its model API. It
 * still refuses to start on any host without the engine (fail closed).
 */
export const CLAUDE_CODE_EXAMPLE_CONFIG = {
  id: "claude-code-disposable",
  displayName: "Claude Code Disposable Project",
  agentType: "claudeCode",
  command: "claude",
  args: [] as string[],
  workingDirectory: "../orbitory-sandbox-project",
  enabled: false,
  maxRuntimeSeconds: 900,
  envAllowlist: ["ANTHROPIC_API_KEY"] as string[],
  sandbox: {
    mode: "container",
    required: true,
    engine: "docker",
    image: "orbitory-local/claude-code:latest",
    allowNetwork: false,
    memoryLimit: "1g",
    cpuLimit: "2",
    pidsLimit: 256,
  },
} as const;

/**
 * The canonical, disabled-by-default Codex example entry (Phase 5). Twin of
 * `CLAUDE_CODE_EXAMPLE_CONFIG` above and single source of truth for
 * `orbitory.config.example.json`, the docs, and the drift test. Inert until a
 * host operator points it at a real disposable project and flips `enabled`.
 *
 * `command: "codex"` with `args: ["exec"]` is the documented, conservative
 * invocation, verified locally against `codex-cli 0.139.0`: bare `codex` opens
 * an interactive TUI (unsuitable for supervised, piped streaming), whereas
 * `codex exec` runs non-interactively and reads its prompt from stdin when none
 * is passed as an argument — matching Orbitory's `initialPrompt`/`chat.message`
 * → stdin model. Never supplied by the client. See docs/PHASE5_CODEX_ADAPTER.md.
 *
 * Ships `sandbox.required: true` with `allowNetwork: false` — the fail-safe
 * default. NOTE (documented in the Phase 5/5.5 docs): a *real* Codex run needs
 * network to reach its model API, so an operator running real Codex must
 * consciously set `allowNetwork: true` (widening the sandbox). That tradeoff is
 * exactly why real credential-bearing use stays out of scope for this Alpha.
 *
 * Phase 5.5 moved it to `mode: "container"` with an operator-built placeholder
 * image. `envAllowlist` is empty because Codex's auth is login-state files
 * (`~/.codex`), which have no safe path into a container in this Alpha —
 * another documented open question keeping real Codex manual/experimental.
 */
/**
 * The canonical, disabled-by-default **stream-json** Claude Code entry
 * (Phase 16) — the one that produces real status/summaries/chat/approvals on
 * the phone via `ClaudeCodeStreamProvider`. Single source of truth for
 * `orbitory.config.example.json` and the drift test, like the two above.
 *
 * Choices, stated bluntly (see docs/PHASE16_REAL_AGENT_INTEGRATION.md §4.7):
 * - `sandbox: sandbox-exec, required: true, allowNetwork: true` — a real CLI
 *   needs the network (model API) and the Mac user's existing `claude` login
 *   (Keychain/`~/.claude`), which a container cannot see; seatbelt confines
 *   writes to the working directory but NOT reads, and the open network is an
 *   exfiltration channel. That is why this stays disabled, points at a
 *   disposable project, and is never described as "safe".
 * - `envAllowlist: ["PATH", "HOME", "USER", "LOGNAME"]` — the minimum
 *   identity/login context verified against the runtime CLI; the pairing
 *   token is stripped unconditionally regardless.
 * - `approvalTimeoutSeconds: 300` — an unanswered permission request DENIES
 *   after 5 minutes (fail closed).
 */
export const CLAUDE_CODE_STREAM_EXAMPLE_CONFIG = {
  id: "claude-code-stream",
  displayName: "Claude Code (stream, disposable project)",
  agentType: "claudeCode",
  command: "claude",
  args: [] as string[],
  workingDirectory: "../../orbitory-claude-stream-project",
  enabled: false,
  io: "stream-json",
  maxRuntimeSeconds: 3600,
  approvalTimeoutSeconds: 300,
  envAllowlist: ["PATH", "HOME", "USER", "LOGNAME"] as string[],
  sandbox: {
    mode: "sandbox-exec",
    required: true,
    allowNetwork: true,
    allowedWorkingDirectoryOnly: true,
  },
} as const;

export const CODEX_EXAMPLE_CONFIG = {
  id: "codex-disposable",
  displayName: "Codex Disposable Project",
  agentType: "codex",
  command: "codex",
  args: ["exec"] as string[],
  workingDirectory: "../orbitory-codex-sandbox-project",
  enabled: false,
  maxRuntimeSeconds: 900,
  envAllowlist: [] as string[],
  sandbox: {
    mode: "container",
    required: true,
    engine: "docker",
    image: "orbitory-local/codex:latest",
    allowNetwork: false,
    memoryLimit: "1g",
    cpuLimit: "2",
    pidsLimit: 256,
  },
} as const;
