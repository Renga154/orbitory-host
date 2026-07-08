/**
 * Host-side allowlist configuration for `TerminalAgentProvider`.
 *
 * This is the single, host-controlled source of truth for which terminal
 * commands Orbitory is allowed to launch. The iOS client can never supply a
 * command or argument list itself — it can only reference an already
 * configured, already `enabled` entry by its stable `id` (see the
 * `providerId` field on the `session.start` client event in
 * `docs/protocol.md`). If `providerId` doesn't match anything loaded here,
 * `sessionStore.startSession` rejects the request; it never falls back to
 * treating the id as a literal command.
 *
 * The config file itself (`orbitory.config.json` by default, or the path in
 * `ORBITORY_AGENT_CONFIG_PATH`) is edited by whoever runs the host-agent —
 * the same person who already has full shell access to the host machine.
 * This module's job is to load and validate that file defensively (skip and
 * warn on a malformed entry rather than crash the whole server), not to
 * defend against a hostile config file — that would already imply a
 * compromised host, which is out of scope (see docs/security.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AgentType,
  ProviderDescriptor,
  ProviderNetworkPolicy,
  ProviderUnavailableReason,
  RiskLevel,
} from "./types.js";
import {
  defaultResolvedSandbox,
  ENV_NAME_PATTERN,
  isSandboxModeSupported,
  resolveSandboxPolicy,
  SANDBOX_MODES,
  validateContainerConfig,
  type ContainerEngine,
  type ResolvedSandbox,
  type SandboxMode,
  type SandboxPolicy,
} from "./sandbox.js";

/** The `AgentType` values a config entry may declare, and the fallback. */
const KNOWN_AGENT_TYPES: readonly AgentType[] = [
  "claudeCode",
  "codex",
  "geminiCli",
  "aider",
  "openCode",
  "custom",
];

/** One host-configured terminal agent that `TerminalAgentProvider` may launch. */
export interface TerminalAgentConfig {
  /** Stable id clients reference via `session.start.payload.providerId`. */
  id: string;
  /** Human-readable name shown in logs and (via the session title) to the user. */
  displayName: string;
  /**
   * Host-authoritative agent type. Controls how a terminal-backed session is
   * *labeled* (e.g. `claudeCode` → shown as "Claude Code" in the app) and
   * which bilingual status copy it gets (see `providers/agentPresets.ts`).
   * It does NOT change how the process is executed — every terminal agent
   * runs through the exact same safe path regardless of type. Defaults to
   * `"custom"` when omitted. The client's `session.start.agentType` is only a
   * hint for mock sessions; for a terminal-backed session this config value
   * wins (the host knows what it configured to run, the phone doesn't).
   */
  agentType: AgentType;
  /**
   * Executable to run — either a bare name resolved via `PATH` (e.g.
   * `"node"`) or an absolute path (e.g. `"/usr/local/bin/node"`, which is
   * intentionally allowed: pinning an exact binary is more precise, not
   * less). Never shell-interpreted (see TerminalAgentProvider — no
   * `shell: true`), and entries whose command contains whitespace or shell
   * metacharacters are rejected at load time — those are inert without a
   * shell anyway, but their presence almost always means the author
   * expected shell semantics (`"node script.js && ..."`), so failing loudly
   * beats silently running something other than what they meant.
   */
  command: string;
  /** Argument vector passed directly to `command`. Never shell-interpreted. */
  args: string[];
  /** Absolute path the process is spawned in. Resolved relative to the config file's own directory. */
  workingDirectory: string;
  /**
   * Wall-clock ceiling for the spawned process, in seconds. When exceeded,
   * the provider terminates it (SIGTERM, then SIGKILL) and fails the
   * session. Defaults to `DEFAULT_MAX_RUNTIME_SECONDS` when omitted — there
   * is deliberately no "unlimited" setting in the Alpha.
   */
  maxRuntimeSeconds: number;
  /**
   * How long a Phase 16 approval-bridge permission request may stay pending
   * before it is DENIED (fail closed), in seconds. Only consulted by the
   * stream-json Claude Code provider (`ClaudeCodeStreamProvider`); harmless
   * on other entries. Defaults to `DEFAULT_APPROVAL_TIMEOUT_SECONDS`.
   */
  approvalTimeoutSeconds: number;
  /**
   * Provider I/O mode (Phase 16). Omitted or `"text"` → the generic
   * `TerminalAgentProvider` path, byte-for-byte the pre-Phase-16 behavior.
   * `"stream-json"` → `ClaudeCodeStreamProvider` drives the process over
   * Claude Code's public stream-json interface (structured events, real chat,
   * real approvals). Only accepted with `agentType: "claudeCode"` — the
   * stream schema and permission-prompt mechanism are Claude Code's. This
   * field is host-only and is NEVER exposed in a `ProviderDescriptor`.
   */
  io?: "text" | "stream-json";
  /**
   * Optional environment allowlist. When **present** (the key exists in the
   * config, even as an empty array), the spawned process receives ONLY these
   * keys from the host-agent's own environment — a least-privilege posture
   * for a real CLI that needs, say, just `PATH`/`HOME`/`ANTHROPIC_API_KEY`
   * (an empty array therefore passes *nothing*, fail-closed). When **omitted**
   * (`undefined`), the process inherits the full environment (the less-safe
   * default, documented in docs/security.md §4). Either way
   * `ORBITORY_PAIRING_TOKEN` is always stripped, and env values are never
   * logged or sent to the client. An allowlisted key that isn't set in the
   * host-agent's environment is simply absent from the child's (not an error).
   *
   * **Container mode (Phase 5.5) differs, deliberately:** these keys are
   * forwarded INTO the container via key-only `-e KEY` flags (values never
   * appear in argv), and an *omitted* allowlist forwards **nothing** — the
   * container starts from the image's own environment (least privilege),
   * rather than inheriting the host's. Keys must be plain env-var names
   * (validated at load). The engine *client* process itself still gets the
   * host env minus the pairing token (it is host tooling and needs its own
   * config); `envAllowlist` governs the agent's environment, in both modes.
   */
  envAllowlist?: string[];
  /**
   * Resolved runtime sandbox policy (Phase 4.5, see `sandbox.ts` and
   * `docs/PHASE4_5_RUNTIME_SANDBOXING.md`). Always present: when the config
   * entry omits a `sandbox` block this is `defaultResolvedSandbox()`
   * (`effectiveMode: "none"`, i.e. the pre-4.5 unsandboxed behavior). When a
   * block is present it has been structurally validated *and* resolved against
   * what this host can actually enforce — so `effectiveMode` is the mode that
   * will really be applied at spawn (possibly a downgrade of the requested one;
   * a `required` mode this host can't enforce causes the whole entry to be
   * rejected at load instead, and never reaches here).
   */
  sandbox: ResolvedSandbox;
}

/**
 * Default per-session runtime ceiling (1 hour) applied when an entry doesn't
 * set `maxRuntimeSeconds` itself. Generous enough for a long real coding
 * session, small enough that a forgotten/hung process can't run for days.
 */
export const DEFAULT_MAX_RUNTIME_SECONDS = 3_600;

/**
 * Default approval-bridge timeout (5 minutes): long enough to pick up the
 * phone, short enough that a forgotten approval doesn't stall a session for
 * hours. Timing out DENIES the action (fail closed) — see `approvalBridge.ts`.
 */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

/**
 * Upper bound on `maxRuntimeSeconds`. `TerminalAgentProvider` arms the
 * runtime ceiling with `setTimeout(fn, maxRuntimeSeconds * 1000)`, and
 * Node's timer delay is a 32-bit signed int of milliseconds — a delay above
 * 2^31-1 ms silently clamps to 1ms (`TimeoutOverflowWarning`), which would
 * make a *huge* configured ceiling fire almost immediately and kill the
 * session ~1ms after spawn with a misleading "exceeded maximum runtime"
 * reason (the exact inversion of the author's intent). Reject anything above
 * this so that can't happen: 2_147_483 s ≈ 24.8 days, comfortably beyond any
 * legitimate single session.
 */
export const MAX_ALLOWED_MAX_RUNTIME_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/**
 * Characters that are never valid in a `command` value: whitespace plus
 * every common shell metacharacter. See the `command` field doc above for
 * why these are rejected even though no shell ever interprets them.
 */
const COMMAND_REJECT_PATTERN = /[\s;&|<>$`\\"'(){}[\]*?~#!]/;

interface RawAgentConfigEntry {
  id?: unknown;
  displayName?: unknown;
  agentType?: unknown;
  command?: unknown;
  args?: unknown;
  workingDirectory?: unknown;
  enabled?: unknown;
  maxRuntimeSeconds?: unknown;
  approvalTimeoutSeconds?: unknown;
  envAllowlist?: unknown;
  sandbox?: unknown;
  io?: unknown;
}

/**
 * Every key a `sandbox` block may contain. Anything else is rejected loudly
 * (see below) — in particular there is deliberately NO key for extra mounts,
 * volumes, or raw engine flags, so a config can never mount the Docker socket,
 * the home directory, or anything beyond the single validated working
 * directory. `mounts`/`volumes`/`extraArgs` in a config are typos or attempts
 * at exactly what this Alpha refuses to support; both must fail loud.
 */
const SANDBOX_KNOWN_KEYS: readonly string[] = [
  "mode",
  "required",
  "allowNetwork",
  "allowedWorkingDirectoryOnly",
  // container-mode fields (Phase 5.5):
  "engine",
  "image",
  "containerWorkspace",
  "workspaceMount",
  "memoryLimit",
  "cpuLimit",
  "pidsLimit",
  "readOnlyRootFilesystem",
  "dropCapabilities",
  "noNewPrivileges",
  "user",
];

/** The container-only keys, used to reject their presence on non-container modes. */
const SANDBOX_CONTAINER_ONLY_KEYS: readonly string[] = SANDBOX_KNOWN_KEYS.slice(4);

/**
 * Structurally validate a raw `sandbox` block into a `SandboxPolicy`.
 *
 * Returns:
 * - `{ ok: true, policy: undefined }` when no block is present (→ the entry
 *   gets `defaultResolvedSandbox()`, i.e. unsandboxed, preserving pre-4.5
 *   behavior).
 * - `{ ok: true, policy }` for a well-formed block.
 * - `{ ok: false }` for a malformed block — the caller drops the whole entry.
 *   Unlike a bad `agentType` (which falls back to `"custom"`), a malformed
 *   sandbox policy is NEVER silently downgraded: getting isolation wrong is a
 *   safety issue, so it fails loud rather than quietly running less confined
 *   than the author intended. That includes unknown keys (a typo'd isolation
 *   field silently ignored could mean "less confined than the author thinks").
 */
function parseSandboxPolicy(
  raw: unknown,
  label: string,
): { ok: true; policy: SandboxPolicy | undefined } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, policy: undefined };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[orbitory-host-agent] ${label}: "sandbox" must be an object; skipping.`);
    return { ok: false };
  }
  const r = raw as Record<string, unknown>;

  for (const key of Object.keys(r)) {
    if (!SANDBOX_KNOWN_KEYS.includes(key)) {
      console.warn(
        `[orbitory-host-agent] ${label}: unknown "sandbox.${key}" — sandbox fields are strictly ` +
          `validated (and there is deliberately no way to add extra mounts or raw engine flags); skipping.`,
      );
      return { ok: false };
    }
  }

  if (typeof r.mode !== "string" || !(SANDBOX_MODES as readonly string[]).includes(r.mode)) {
    console.warn(
      `[orbitory-host-agent] ${label}: "sandbox.mode" must be one of ${SANDBOX_MODES.join(", ")}; skipping.`,
    );
    return { ok: false };
  }
  for (const key of ["required", "allowNetwork", "allowedWorkingDirectoryOnly"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "boolean") {
      console.warn(`[orbitory-host-agent] ${label}: "sandbox.${key}" must be a boolean; skipping.`);
      return { ok: false };
    }
  }

  if (r.mode !== "container") {
    const strays = SANDBOX_CONTAINER_ONLY_KEYS.filter((k) => r[k] !== undefined);
    if (strays.length > 0) {
      console.warn(
        `[orbitory-host-agent] ${label}: "sandbox.${strays[0]}" is only valid with mode "container" ` +
          `(declared mode: "${r.mode}") — refusing to guess what was meant; skipping.`,
      );
      return { ok: false };
    }
    return {
      ok: true,
      policy: {
        mode: r.mode as SandboxMode,
        required: r.required === true, // default false
        allowNetwork: r.allowNetwork !== false, // default true
        allowedWorkingDirectoryOnly: r.allowedWorkingDirectoryOnly !== false, // default true
      },
    };
  }

  const containerParse = validateContainerConfig(r, label);
  if (!containerParse.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    policy: {
      mode: "container",
      required: r.required === true,
      // Container network is FAIL-SAFE OFF by default: an omitted `allowNetwork`
      // means `--network none`, and enabling network is an explicit, documented
      // opt-in (`allowNetwork: true`). This deliberately differs from the
      // sandbox-exec parser's default-true above — for a read-confining
      // container, an accidentally-omitted key must never silently grant the
      // agent an exfiltration channel.
      allowNetwork: r.allowNetwork === true,
      allowedWorkingDirectoryOnly: r.allowedWorkingDirectoryOnly !== false,
      container: containerParse.config,
    },
  };
}

/**
 * When a sandbox policy asks for confinement (`mode !== "none"`), reject a
 * working directory that resolves (after following symlinks) to a dangerous
 * root: the filesystem root, the user's home directory itself, or a common
 * system directory. Best-effort — not a complete list of every sensitive path,
 * just the obvious feet-shooters — and applied only to sandbox-confined entries
 * so existing unsandboxed configs (e.g. the demo agent) are unaffected.
 *
 * Includes BOTH macOS and Linux canonical locations, because for container mode
 * this list (prefix-matched, see `containerMountIsSafe`) is what stops the
 * working directory being bind-mounted into a container. Critically, `/run`
 * (and `/root`) are Linux — on Linux `/var/run` is a symlink to `/run`, which
 * holds `/run/docker.sock`, so realpath resolution moves the path OUT of the
 * `/var` prefix; without `/run` here a Linux operator pointing a container at
 * `/var/run` or `/run` would bind-mount the Docker socket and defeat the whole
 * sandbox. `/proc`, `/sys`, `/boot` are likewise never valid mount sources.
 */
const CONFINEMENT_DENY_DIRS: readonly string[] = [
  "/etc",
  "/private/etc",
  "/var",
  "/private/var",
  "/run",
  "/private/var/run",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/root",
  "/System",
  "/Library",
  "/private",
  "/Applications",
  "/cores",
];

function confinedWorkingDirectoryIsSafe(
  resolvedWorkingDirectory: string,
  label: string,
): boolean {
  let real: string;
  try {
    real = fs.realpathSync(resolvedWorkingDirectory);
  } catch {
    real = resolvedWorkingDirectory;
  }

  const root = path.parse(real).root;
  if (real === root) {
    console.warn(
      `[orbitory-host-agent] ${label}: sandboxed workingDirectory resolves to the filesystem root ("${real}"); skipping.`,
    );
    return false;
  }
  if (real === os.homedir()) {
    console.warn(
      `[orbitory-host-agent] ${label}: sandboxed workingDirectory resolves to the home directory ("${real}"); ` +
        `point it at a specific disposable project instead. Skipping.`,
    );
    return false;
  }
  if (CONFINEMENT_DENY_DIRS.includes(real)) {
    console.warn(
      `[orbitory-host-agent] ${label}: sandboxed workingDirectory resolves to a system directory ("${real}"); skipping.`,
    );
    return false;
  }
  return true;
}

/**
 * Container-mode working directories get a STRONGER check than the exact-match
 * rule above, because the directory becomes a bind **mount**: mounting
 * `/var/run` would hand the container the Docker socket, `/etc` its config,
 * etc. So for container mode the (symlink-resolved) path is rejected when it
 * is *under* any system directory, not merely equal to one — with an explicit
 * exception for temp locations (`/tmp`, `/private/tmp`, and the process
 * TMPDIR), where disposable test projects legitimately live. The home
 * directory itself is already rejected by `confinedWorkingDirectoryIsSafe`;
 * paths *under* home are allowed — that is where real projects live.
 *
 * Also rejects paths containing `:` (they would corrupt the `-v host:container
 * :mode` mount spec — mount-option injection) or `,`.
 */
function containerMountIsSafe(resolvedWorkingDirectory: string, label: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(resolvedWorkingDirectory);
  } catch {
    real = resolvedWorkingDirectory;
  }

  if (real.includes(":") || real.includes(",")) {
    console.warn(
      `[orbitory-host-agent] ${label}: container workingDirectory path contains ":" or "," ` +
        `(would corrupt the volume mount spec); skipping.`,
    );
    return false;
  }

  // Temp-project exception: strictly *under* a temp root (mounting the whole
  // temp root itself would expose every other process's temp files).
  const tempRoots = ["/tmp", "/private/tmp"];
  try {
    tempRoots.push(fs.realpathSync(os.tmpdir()));
  } catch {
    // TMPDIR unresolvable; fall through with the static roots only.
  }
  for (const root of tempRoots) {
    if (real.startsWith(`${root}/`)) {
      return true;
    }
  }

  for (const denied of CONFINEMENT_DENY_DIRS) {
    if (real === denied || real.startsWith(`${denied}/`)) {
      console.warn(
        `[orbitory-host-agent] ${label}: container workingDirectory ("${real}") is inside the system ` +
          `directory "${denied}" — refusing to bind-mount it into a container; skipping.`,
      );
      return false;
    }
  }
  return true;
}

function coerceAgentType(raw: unknown, label: string): AgentType {
  if (raw === undefined) {
    return "custom";
  }
  if (typeof raw === "string" && (KNOWN_AGENT_TYPES as readonly string[]).includes(raw)) {
    return raw as AgentType;
  }
  // Host's own file, so a bad agentType is a typo, not an attack: warn and
  // fall back to "custom" rather than dropping the whole (possibly otherwise
  // valid) entry.
  console.warn(
    `[orbitory-host-agent] ${label}: unrecognized "agentType" (${JSON.stringify(raw)}); treating as "custom".`,
  );
  return "custom";
}

interface RawAgentConfigFile {
  agents?: unknown;
}

function defaultConfigPath(): string {
  return (
    process.env["ORBITORY_AGENT_CONFIG_PATH"] ??
    path.join(process.cwd(), "orbitory.config.json")
  );
}

/**
 * Validates a single raw JSON entry against `TerminalAgentConfig`, resolving
 * `workingDirectory` relative to `configDir` (the directory the config file
 * itself lives in — not `process.cwd()`, which can vary depending on how the
 * host-agent happens to be launched, so a config author's relative path
 * means the same thing regardless of the process's current directory).
 *
 * Returns `undefined` (after logging a warning identifying which field was
 * wrong) for any entry that fails validation, is disabled, or whose
 * `workingDirectory` doesn't resolve to an existing directory — callers
 * should skip that one entry and continue loading the rest of the file
 * rather than aborting entirely.
 */
function validateEntry(
  raw: RawAgentConfigEntry,
  index: number,
  configDir: string,
): TerminalAgentConfig | undefined {
  const label = `orbitory.config.json agents[${index}]`;

  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    console.warn(`[orbitory-host-agent] ${label}: missing or empty "id"; skipping this entry.`);
    return undefined;
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    console.warn(`[orbitory-host-agent] ${label} ("${raw.id}"): missing or empty "command"; skipping.`);
    return undefined;
  }
  if (COMMAND_REJECT_PATTERN.test(raw.command)) {
    // Deliberately don't echo the command value itself into the log — the
    // warning names the entry, which is enough to find it in the file.
    // Note: a plain path separator ("/") and dots are NOT rejected, so a
    // bare name ("node"), a relative path ("scripts/agent.js", "./agent"),
    // and an absolute path ("/usr/local/bin/node") are all accepted — only
    // whitespace and shell metacharacters are refused.
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "command" contains whitespace or shell ` +
        `metacharacters — it must be a single executable name or path (bare, relative, or ` +
        `absolute), with any arguments in "args"; skipping.`,
    );
    return undefined;
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))) {
    console.warn(`[orbitory-host-agent] ${label} ("${raw.id}"): "args" must be an array of strings; skipping.`);
    return undefined;
  }
  if (raw.workingDirectory !== undefined && typeof raw.workingDirectory !== "string") {
    console.warn(`[orbitory-host-agent] ${label} ("${raw.id}"): "workingDirectory" must be a string; skipping.`);
    return undefined;
  }
  if (
    raw.maxRuntimeSeconds !== undefined &&
    (typeof raw.maxRuntimeSeconds !== "number" ||
      !Number.isFinite(raw.maxRuntimeSeconds) ||
      raw.maxRuntimeSeconds <= 0)
  ) {
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "maxRuntimeSeconds" must be a positive number; skipping.`,
    );
    return undefined;
  }
  if (
    typeof raw.maxRuntimeSeconds === "number" &&
    raw.maxRuntimeSeconds > MAX_ALLOWED_MAX_RUNTIME_SECONDS
  ) {
    // A ceiling above ~24.8 days would overflow setTimeout's 32-bit ms delay
    // and, counterintuitively, kill the session ~1ms after spawn. Reject it
    // rather than silently inverting the author's intent (see the constant's
    // doc). Anyone who genuinely wants "effectively unlimited" should use a
    // value up to MAX_ALLOWED_MAX_RUNTIME_SECONDS.
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "maxRuntimeSeconds" (${raw.maxRuntimeSeconds}) exceeds ` +
        `the maximum of ${MAX_ALLOWED_MAX_RUNTIME_SECONDS}s (~24.8 days); skipping.`,
    );
    return undefined;
  }
  if (
    raw.approvalTimeoutSeconds !== undefined &&
    (typeof raw.approvalTimeoutSeconds !== "number" ||
      !Number.isFinite(raw.approvalTimeoutSeconds) ||
      raw.approvalTimeoutSeconds <= 0 ||
      raw.approvalTimeoutSeconds > MAX_ALLOWED_MAX_RUNTIME_SECONDS)
  ) {
    // Same rationale (and same setTimeout-overflow ceiling) as maxRuntimeSeconds.
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "approvalTimeoutSeconds" must be a positive number ` +
        `no greater than ${MAX_ALLOWED_MAX_RUNTIME_SECONDS}; skipping.`,
    );
    return undefined;
  }
  if (
    raw.envAllowlist !== undefined &&
    (!Array.isArray(raw.envAllowlist) || !raw.envAllowlist.every((k) => typeof k === "string"))
  ) {
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "envAllowlist" must be an array of strings; skipping.`,
    );
    return undefined;
  }

  const sandboxParse = parseSandboxPolicy(raw.sandbox, `${label} ("${raw.id}")`);
  if (!sandboxParse.ok) {
    return undefined;
  }

  // Phase 16 `io` mode. Unlike a bad `agentType` (cosmetic, falls back to
  // "custom"), a bad `io` value changes which EXECUTION PATH drives the
  // process — never guess; drop the entry loudly.
  const agentType = coerceAgentType(raw.agentType, `${label} ("${raw.id}")`);
  if (raw.io !== undefined && raw.io !== "text" && raw.io !== "stream-json") {
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): "io" must be "text" or "stream-json"; skipping.`,
    );
    return undefined;
  }
  if (raw.io === "stream-json" && agentType !== "claudeCode") {
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): io "stream-json" is only supported with ` +
        `agentType "claudeCode" (the stream schema and permission-prompt mechanism are Claude Code's); skipping.`,
    );
    return undefined;
  }
  if (raw.io === "stream-json" && sandboxParse.policy?.mode === "container") {
    // The stream provider's MCP approval bridge references host filesystem
    // paths (node + scripts/orbitory-approval-bridge.js + a host tmp MCP
    // config) that do not exist inside a container, so this combination can
    // only produce a silently broken bridge. Fail loud instead.
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): io "stream-json" does not support sandbox mode ` +
        `"container" in this phase (the approval bridge runs from host paths); use "sandbox-exec" or "none". Skipping.`,
    );
    return undefined;
  }

  // Fail closed: an entry with no explicit "enabled": true is treated as
  // disabled, so simply adding an entry to the file (e.g. while editing it)
  // never accidentally makes a new command launchable.
  const enabled = raw.enabled === true;
  if (!enabled) {
    console.warn(`[orbitory-host-agent] ${label} ("${raw.id}"): not enabled (enabled !== true); skipping.`);
    return undefined;
  }

  const resolvedWorkingDirectory = path.resolve(configDir, raw.workingDirectory ?? ".");
  if (!fs.existsSync(resolvedWorkingDirectory) || !fs.statSync(resolvedWorkingDirectory).isDirectory()) {
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): workingDirectory "${resolvedWorkingDirectory}" ` +
        `does not exist or is not a directory; skipping.`,
    );
    return undefined;
  }
  if (resolvedWorkingDirectory === path.parse(resolvedWorkingDirectory).root) {
    // Running an agent from the filesystem root is never what a config
    // author actually wants — it's almost always a path-resolution mistake,
    // and it maximizes the blast radius of an unsandboxed process.
    console.warn(
      `[orbitory-host-agent] ${label} ("${raw.id}"): workingDirectory resolves to the filesystem ` +
        `root ("${resolvedWorkingDirectory}"); point it at a real project directory instead. Skipping.`,
    );
    return undefined;
  }

  // Sandbox resolution happens only for entries that are otherwise valid,
  // enabled, and have a resolvable workingDirectory.
  let sandbox: ResolvedSandbox = defaultResolvedSandbox();
  if (sandboxParse.policy !== undefined) {
    // A confining policy additionally constrains where it may run.
    if (
      sandboxParse.policy.mode !== "none" &&
      !confinedWorkingDirectoryIsSafe(resolvedWorkingDirectory, `${label} ("${raw.id}")`)
    ) {
      return undefined;
    }
    if (sandboxParse.policy.mode === "container") {
      // A container working directory becomes a bind mount — stronger rules.
      if (!containerMountIsSafe(resolvedWorkingDirectory, `${label} ("${raw.id}")`)) {
        return undefined;
      }
      // envAllowlist keys become `-e KEY` argv for the engine; anything that
      // isn't a plain env NAME (e.g. "FOO=bar", "-e") is a misconfiguration
      // that could set values or read as flags — fail loud. (The builder also
      // filters, as a second line of defense.)
      if (raw.envAllowlist !== undefined) {
        const bad = (raw.envAllowlist as string[]).find((k) => !ENV_NAME_PATTERN.test(k));
        if (bad !== undefined) {
          console.warn(
            `[orbitory-host-agent] ${label} ("${raw.id}"): container envAllowlist entry ` +
              `${JSON.stringify(bad)} is not a plain environment variable name; skipping.`,
          );
          return undefined;
        }
      }
    }
    const resolved = resolveSandboxPolicy(sandboxParse.policy);
    if (resolved.mustReject) {
      // Fail closed: the operator required a sandbox mode this host cannot
      // enforce. Drop the entry entirely rather than run it unsandboxed — the
      // client then gets the same "unknown or disabled providerId" rejection as
      // for any other unavailable provider.
      console.warn(
        `[orbitory-host-agent] ${label} ("${raw.id}"): sandbox.mode "${resolved.requestedMode}" is required but ` +
          `cannot be enforced on this host; skipping (fail closed).`,
      );
      return undefined;
    }
    if (resolved.downgraded) {
      console.warn(
        `[orbitory-host-agent] ${label} ("${raw.id}"): sandbox.mode "${resolved.requestedMode}" is not enforceable ` +
          `on this host and was not required; downgraded to "none" (running UNSANDBOXED).`,
      );
    }
    sandbox = resolved;
  }

  return {
    id: raw.id,
    displayName: typeof raw.displayName === "string" && raw.displayName.trim().length > 0 ? raw.displayName : raw.id,
    agentType,
    command: raw.command,
    args: (raw.args as string[] | undefined) ?? [],
    workingDirectory: resolvedWorkingDirectory,
    maxRuntimeSeconds: (raw.maxRuntimeSeconds as number | undefined) ?? DEFAULT_MAX_RUNTIME_SECONDS,
    approvalTimeoutSeconds:
      (raw.approvalTimeoutSeconds as number | undefined) ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    ...(raw.envAllowlist !== undefined ? { envAllowlist: raw.envAllowlist as string[] } : {}),
    sandbox,
    ...(raw.io !== undefined ? { io: raw.io as "text" | "stream-json" } : {}),
  };
}

/**
 * Loads and validates the terminal-agent allowlist from `configPath`
 * (defaulting to `ORBITORY_AGENT_CONFIG_PATH` or `<cwd>/orbitory.config.json`
 * when omitted). Returns a `Map` keyed by `id` containing only entries that
 * are structurally valid, `enabled: true`, and have a resolvable
 * `workingDirectory` — every other entry is skipped with a logged warning.
 *
 * It is not an error for the config file to be missing entirely: most
 * installs don't configure any terminal agents and rely on Mock Mode alone,
 * so this returns an empty Map (and logs nothing) in that case.
 */
export function loadAgentConfigs(configPath: string = defaultConfigPath()): Map<string, TerminalAgentConfig> {
  const result = new Map<string, TerminalAgentConfig>();

  if (!fs.existsSync(configPath)) {
    return result;
  }

  let raw: RawAgentConfigFile;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    raw = JSON.parse(text) as RawAgentConfigFile;
  } catch (err) {
    console.warn(
      `[orbitory-host-agent] Failed to read/parse ${configPath}; no terminal agents will be available. ` +
        `(${(err as Error).message})`,
    );
    return result;
  }

  if (!Array.isArray(raw.agents)) {
    console.warn(`[orbitory-host-agent] ${configPath}: expected an "agents" array; no terminal agents loaded.`);
    return result;
  }

  const configDir = path.dirname(path.resolve(configPath));

  raw.agents.forEach((entry, index) => {
    const validated = validateEntry(entry as RawAgentConfigEntry, index, configDir);
    if (!validated) {
      return;
    }
    if (result.has(validated.id)) {
      console.warn(
        `[orbitory-host-agent] orbitory.config.json: duplicate agent id "${validated.id}"; keeping the first, ignoring this one.`,
      );
      return;
    }
    result.set(validated.id, validated);
  });

  if (result.size > 0) {
    console.log(
      `[orbitory-host-agent] Loaded ${result.size} terminal agent(s) from ${configPath}: ` +
        `${Array.from(result.values()).map((c) => c.id).join(", ")}`,
    );
  }

  return result;
}

/** The process-wide allowlist, loaded once at import time from the default config path. */
export const agentConfigs: Map<string, TerminalAgentConfig> = loadAgentConfigs();

// ---------------------------------------------------------------------------
// Provider descriptors (Phase 6) — sanitized, read-only views for the client.
// ---------------------------------------------------------------------------

/**
 * Coarse network summary for the UI. Only `container`/`sandbox-exec` govern
 * network at all; `none`/`restricted-process` don't restrict it, so `not_applicable`.
 */
function providerNetworkPolicy(mode: SandboxMode, allowNetwork: boolean): ProviderNetworkPolicy {
  if (mode === "container" || mode === "sandbox-exec") {
    return allowNetwork ? "allowed" : "denied";
  }
  return "not_applicable";
}

/** Coarse, deliberately conservative risk classification for display. */
function providerRiskLevel(agentType: AgentType, mode: SandboxMode, allowNetwork: boolean): RiskLevel {
  const realCli = agentType === "claudeCode" || agentType === "codex";
  if (realCli) {
    // A real, credential-capable CLI is only "low" risk under container
    // isolation with the network off; anything weaker is high.
    if (mode !== "container") return "high";
    return allowNetwork ? "medium" : "low";
  }
  if (mode === "none") return "medium"; // arbitrary command, unsandboxed
  return "low";
}

/** Stable warning codes (localized client-side). */
function providerWarnings(
  agentType: AgentType,
  mode: SandboxMode,
  allowNetwork: boolean,
  sandboxSupported: boolean,
): string[] {
  const warnings: string[] = [];
  if (mode === "none") warnings.push("unsandboxed");
  if (mode === "sandbox-exec") warnings.push("reads_not_confined");
  if ((mode === "container" || mode === "sandbox-exec") && allowNetwork) warnings.push("network_allowed");
  if (agentType === "claudeCode" || agentType === "codex") warnings.push("real_cli_disposable_only");
  if (!sandboxSupported && mode !== "none") warnings.push("sandbox_unsupported");
  return warnings;
}

/** Build a startable descriptor from a loaded (valid, enabled) config. */
function descriptorForLoadedConfig(config: TerminalAgentConfig): ProviderDescriptor {
  const sb = config.sandbox;
  // Risk/network/warnings reflect what's actually ENFORCED (effectiveMode); the
  // displayed sandboxMode is what was REQUESTED (so a downgraded-to-none entry
  // honestly reads "requested container, unsupported, running unsandboxed").
  return {
    id: config.id,
    displayName: config.displayName,
    agentType: config.agentType,
    enabled: true,
    startable: true,
    unavailableReason: null,
    sandboxMode: sb.requestedMode,
    sandboxRequired: sb.required,
    sandboxSupported: sb.supported,
    networkPolicy: providerNetworkPolicy(sb.effectiveMode, sb.allowNetwork),
    riskLevel: providerRiskLevel(config.agentType, sb.effectiveMode, sb.allowNetwork),
    warnings: providerWarnings(config.agentType, sb.effectiveMode, sb.allowNetwork, sb.supported),
  };
}

/** Classify why an enabled-but-not-loaded (or disabled) entry can't start. */
function classifyUnavailableReason(
  enabled: boolean,
  mode: SandboxMode,
  required: boolean,
  sandboxSupported: boolean,
): ProviderUnavailableReason {
  if (!enabled) return "disabled";
  if (required && !sandboxSupported) {
    return mode === "container" ? "container_engine_unavailable" : "sandbox_required_but_unavailable";
  }
  // Enabled but dropped for another reason (bad command/args/working dir/etc.).
  // Coarse but honest — the specifics stay host-side (docs/security.md §5).
  return "invalid_config";
}

/** Build a non-startable descriptor from a raw (disabled/invalid) entry, sanitized. */
function descriptorForRejectedEntry(raw: RawAgentConfigEntry): ProviderDescriptor {
  const id = raw.id as string;
  const displayName =
    typeof raw.displayName === "string" && raw.displayName.trim().length > 0 ? raw.displayName : id;
  const agentType = coerceAgentType(raw.agentType, `provider "${id}"`);
  const enabled = raw.enabled === true;

  // Lenient, display-only read of the sandbox intent (never surfaces config).
  const rawSb =
    typeof raw.sandbox === "object" && raw.sandbox !== null && !Array.isArray(raw.sandbox)
      ? (raw.sandbox as Record<string, unknown>)
      : undefined;
  const mode: SandboxMode =
    rawSb && typeof rawSb["mode"] === "string" && (SANDBOX_MODES as readonly string[]).includes(rawSb["mode"] as string)
      ? (rawSb["mode"] as SandboxMode)
      : "none";
  const required = rawSb?.["required"] === true;
  const engine = (rawSb && typeof rawSb["engine"] === "string" ? rawSb["engine"] : "docker") as ContainerEngine;
  const sandboxSupported = mode === "none" ? true : isSandboxModeSupported(mode, { containerEngine: engine });
  const allowNetwork =
    mode === "container"
      ? rawSb?.["allowNetwork"] === true // container default: denied
      : mode === "sandbox-exec"
        ? rawSb?.["allowNetwork"] !== false // sandbox-exec default: allowed
        : false;

  return {
    id,
    displayName,
    agentType,
    enabled,
    startable: false,
    unavailableReason: classifyUnavailableReason(enabled, mode, required, sandboxSupported),
    sandboxMode: mode,
    sandboxRequired: required,
    sandboxSupported,
    networkPolicy: providerNetworkPolicy(mode, allowNetwork),
    riskLevel: providerRiskLevel(agentType, mode, allowNetwork),
    warnings: providerWarnings(agentType, mode, allowNetwork, sandboxSupported),
  };
}

/**
 * Build the **sanitized** list of provider descriptors for the client (Phase 6).
 *
 * Startable descriptors come straight from `validConfigs` (the loaded
 * allowlist), so the "startable" set exactly matches what `session.start` will
 * accept. The raw config file is walked only to *also* surface DISABLED /
 * INVALID entries (which the loader drops) with a reason code — and even for
 * those, nothing sensitive (`command`/`args`/`env`/`image`/`workingDirectory`/
 * paths) is ever read into a descriptor. Entries with an unusable `id` are
 * skipped, and duplicate ids keep the first (matching `loadAgentConfigs`).
 */
export function loadProviderDescriptors(
  configPath: string = defaultConfigPath(),
  validConfigs: Map<string, TerminalAgentConfig> = agentConfigs,
): ProviderDescriptor[] {
  const descriptors: ProviderDescriptor[] = [];
  const seen = new Set<string>();

  let rawAgents: RawAgentConfigEntry[] = [];
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawAgentConfigFile;
      if (Array.isArray(parsed.agents)) {
        rawAgents = parsed.agents as RawAgentConfigEntry[];
      }
    } catch {
      // Unreadable/malformed file — fall back to just the loaded set below.
    }
  }

  for (const raw of rawAgents) {
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) continue;
    const id = raw.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const loaded = validConfigs.get(id);
    descriptors.push(loaded ? descriptorForLoadedConfig(loaded) : descriptorForRejectedEntry(raw));
  }

  // Defensive: include any loaded config not represented in the raw walk (e.g.
  // the file changed since load, or the file was unreadable) so the startable
  // set is never *smaller* than what session.start accepts.
  for (const [id, config] of validConfigs) {
    if (!seen.has(id)) {
      seen.add(id);
      descriptors.push(descriptorForLoadedConfig(config));
    }
  }

  return descriptors;
}
