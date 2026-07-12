/**
 * Runtime sandbox policy model for terminal-backed agents (Phase 4.5).
 *
 * This module is the single source of truth for *what isolation a terminal
 * agent runs under* and *whether this host can actually enforce it*. It is
 * deliberately honest: a mode is only ever reported as active if the platform
 * can really enforce it, and a `required` mode that the host cannot enforce is
 * flagged for rejection at config-load time (fail closed) rather than silently
 * ignored. See `docs/PHASE4_5_RUNTIME_SANDBOXING.md` and `docs/security.md` §4.
 *
 * Nothing here spawns a process. `agentConfig.ts` calls `resolveSandboxPolicy`
 * at load time; `providers/AgentProvider.ts` calls `wrapCommandForSandbox`
 * (which uses `buildSandboxExecProfile`) at spawn time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

/**
 * The isolation strategies a terminal agent may declare.
 *
 * - `none` — no OS isolation. Identical to the pre-4.5 behavior. The process
 *   runs with the host-agent's own privileges. Always "supported" (it enforces
 *   nothing).
 * - `restricted-process` — portable process hygiene: the child is spawned in
 *   its own process group (so `session.stop`/timeout can reap the whole tree)
 *   and its working directory is validated against dangerous roots. **Not** a
 *   filesystem or network boundary — a process in this mode can still read and
 *   write anywhere the host user can. Always supported.
 * - `sandbox-exec` — macOS-only, kernel-enforced. Confines filesystem *writes*
 *   to the configured working directory and (optionally) denies network.
 *   Supported only on macOS with `/usr/bin/sandbox-exec` present. Does **not**
 *   confine reads (see docs).
 * - `container` — Docker/Podman-backed (Phase 5.5). Runs the agent inside a
 *   restricted container: the configured image + the working directory mounted
 *   at a fixed workspace path are the process's entire world, so — unlike
 *   `sandbox-exec` — **reads** are confined too, network is denied by default,
 *   and memory/CPU/pids ceilings apply. Supported only when the configured
 *   engine's client binary is on `PATH` (daemon problems surface at spawn as a
 *   clean engine error + failed session). See docs/PHASE5_5_CONTAINER_SANDBOX.md.
 */
export type SandboxMode = "none" | "restricted-process" | "sandbox-exec" | "container";

/** Container engines the `container` mode can drive. Both accept the same `run` argv shape we build. */
export type ContainerEngine = "docker" | "podman";

export const CONTAINER_ENGINES: readonly ContainerEngine[] = ["docker", "podman"];

/** Valid environment variable name — the only shape allowed in a container entry's `envAllowlist`. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Narrow host-owned write exceptions needed for public CLI session state.
 * These paths are never configurable by, logged to, or sent to the phone.
 */
export function agentStateWritablePaths(
  agentType: string,
  homeDirectory = homedir(),
): string[] {
  switch (agentType) {
    case "codex":
      return [path.join(homeDirectory, ".codex")];
    case "claudeCode":
      return [path.join(homeDirectory, ".claude"), path.join(homeDirectory, ".claude.json")];
    default:
      return [];
  }
}

/**
 * Container-specific sandbox settings, validated by `validateContainerConfig`
 * and carried on `SandboxPolicy.container` when `mode === "container"`.
 * Every field is host-config-authored; none of it can come from a client.
 */
export interface ContainerSandboxConfig {
  /** Which engine client to use. Default `"docker"`. */
  engine: ContainerEngine;
  /** Image to run — REQUIRED, strictly validated (no flags/metacharacters/whitespace). */
  image: string;
  /** Absolute path inside the container where the working directory is mounted. Default `"/workspace"`. */
  containerWorkspace: string;
  /** `true` → the workspace is mounted read-only (`:ro`); default `false` (`:rw`). */
  workspaceMountReadonly: boolean;
  /** Optional `--memory` value, e.g. `"512m"` / `"1g"`. Recommended. */
  memoryLimit?: string;
  /** Optional `--cpus` value, e.g. `"1"` / `"1.5"`. Recommended. */
  cpuLimit?: string;
  /** `--pids-limit` value. Default 128 (fork-bomb backstop). */
  pidsLimit: number;
  /** `--read-only` root filesystem (+ `--tmpfs /tmp` scratch). Default `true`. */
  readOnlyRootFilesystem: boolean;
  /** `--cap-drop ALL`. Default `true`. */
  dropCapabilities: boolean;
  /** `--security-opt no-new-privileges`. Default `true`. */
  noNewPrivileges: boolean;
  /** Optional `--user` (name or uid[:gid]); recommended for images with a non-root user. */
  user?: string;
}

export const SANDBOX_MODES: readonly SandboxMode[] = [
  "none",
  "restricted-process",
  "sandbox-exec",
  "container",
];

/** The raw, operator-declared sandbox policy (post structural validation). */
export interface SandboxPolicy {
  mode: SandboxMode;
  /**
   * When `true`, the declared `mode` MUST be enforceable on this host or the
   * config entry is rejected at load (fail closed). When `false` (default), an
   * unenforceable mode is downgraded to `none` with a warning.
   */
  required: boolean;
  /** `sandbox-exec` only: deny all network access when `false`. Default `true`. */
  allowNetwork: boolean;
  /**
   * `sandbox-exec` only: confine filesystem writes to the working directory
   * when `true` (the point of the mode). Default `true`.
   */
  allowedWorkingDirectoryOnly: boolean;
  /** Present iff `mode === "container"` (guaranteed by `agentConfig.ts` validation). */
  container?: ContainerSandboxConfig;
}

/** The resolved policy after checking what this host can actually enforce. */
export interface ResolvedSandbox {
  /** What the operator asked for. */
  requestedMode: SandboxMode;
  /** What will actually be applied at spawn (may be a downgrade of `requestedMode`). */
  effectiveMode: SandboxMode;
  required: boolean;
  allowNetwork: boolean;
  allowedWorkingDirectoryOnly: boolean;
  /** Whether `requestedMode` is enforceable on this host. */
  supported: boolean;
  /** `true` when `effectiveMode !== requestedMode` (an unsupported non-required mode was downgraded). */
  downgraded: boolean;
  /**
   * `true` when the loader MUST reject this entry: a `required` mode that this
   * host cannot enforce. `agentConfig.ts` drops such entries entirely so they
   * can never be started (the client then gets the same "unknown or disabled
   * providerId" rejection as for any other unavailable provider).
   */
  mustReject: boolean;
  /**
   * Present iff `effectiveMode === "container"`: the validated container
   * settings plus the engine client executable resolved on this host.
   */
  container?: ContainerSandboxConfig & { engineExecutable: string };
}

/** The default policy used when a `sandbox` block is omitted from a config entry. */
export function defaultResolvedSandbox(): ResolvedSandbox {
  return {
    requestedMode: "none",
    effectiveMode: "none",
    required: false,
    allowNetwork: true,
    allowedWorkingDirectoryOnly: true,
    supported: true,
    downgraded: false,
    mustReject: false,
  };
}

/**
 * Whether macOS `sandbox-exec` is usable on this host. Cached after first
 * check. `override` exists purely so tests can force the "unavailable" branch
 * on a machine where it *is* available (and vice-versa) without mocking the
 * filesystem.
 */
let sandboxExecAvailableCache: boolean | undefined;
export function sandboxExecAvailable(override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }
  if (sandboxExecAvailableCache === undefined) {
    sandboxExecAvailableCache =
      process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
  }
  return sandboxExecAvailableCache;
}

/**
 * Resolve the container engine's client executable on this host, or `null`
 * when unavailable (which drives the fail-closed / downgrade machinery).
 *
 * Deliberately checks only that the *client binary* exists — a stopped daemon
 * or missing image surfaces at spawn as a clean engine error on stderr and a
 * failed session, which is visible and honest; a load-time daemon probe would
 * be racy and slow. Not cached: it runs only at config load.
 *
 * Two host-env test/ops hooks (the host-agent's environment is operator-
 * controlled, the same trust level as the config file itself):
 * - `ORBITORY_CONTAINER_ENGINE_PATH` — use this executable as the engine
 *   (how the automated tests substitute `tests/fixtures/fake-container-engine.js`
 *   so no Docker/Podman install is ever required).
 * - `ORBITORY_DISABLE_CONTAINER_DETECTION=1` — report "unavailable" even if an
 *   engine exists (how required-mode fail-closed is tested deterministically).
 *
 * `override` (explicit param, used by unit tests): `null` forces unavailable,
 * a string forces that executable, `undefined` runs the normal logic above.
 */
export function resolveContainerEngineExecutable(
  engine: ContainerEngine,
  override?: string | null,
): string | null {
  if (override !== undefined) {
    return override;
  }
  if (process.env["ORBITORY_DISABLE_CONTAINER_DETECTION"] === "1") {
    return null;
  }
  const envOverride = process.env["ORBITORY_CONTAINER_ENGINE_PATH"];
  if (envOverride !== undefined && envOverride.trim().length > 0) {
    const resolved = path.resolve(envOverride.trim());
    return fs.existsSync(resolved) ? resolved : null;
  }
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, engine);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here; keep scanning.
    }
  }
  return null;
}

// -- Container config validation ---------------------------------------------

/**
 * Image reference: name[:tag][@sha256:digest]. Strict by design — lowercase
 * repo path, no whitespace, no shell metacharacters, and (critically) it can
 * never begin with `-`, so a configured image can never be parsed by the
 * engine as a flag. Registry hosts with ports (`registry:5000/x`) are outside
 * this Alpha's pattern (documented limitation).
 */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-\/]*(?::[A-Za-z0-9_][A-Za-z0-9._\-]*)?(?:@sha256:[a-f0-9]{64})?$/;
/** Absolute container path, safe charset only (no `:`/`,`/spaces — those would corrupt the `-v` mount spec). */
const CONTAINER_WORKSPACE_PATTERN = /^\/[A-Za-z0-9._\-\/]+$/;
const MEMORY_LIMIT_PATTERN = /^[0-9]+(?:\.[0-9]+)?[bkmgBKMG]?$/;
const CPU_LIMIT_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const CONTAINER_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-]*(?::[A-Za-z0-9][A-Za-z0-9._\-]*)?$/;
const MAX_PIDS_LIMIT = 1_000_000;

/**
 * Validate the container-specific fields of a raw `sandbox` block into a
 * `ContainerSandboxConfig`, applying defaults. Loud and fail-closed: any
 * malformed field logs a warning naming it and rejects the whole entry —
 * getting isolation wrong is a safety issue, so nothing here is ever silently
 * coerced or downgraded. Pure except for `console.warn`.
 */
export function validateContainerConfig(
  raw: Record<string, unknown>,
  label: string,
): { ok: true; config: ContainerSandboxConfig } | { ok: false } {
  const reject = (why: string): { ok: false } => {
    console.warn(`[orbitory-host-agent] ${label}: ${why}; skipping.`);
    return { ok: false };
  };

  const engine = raw["engine"] === undefined ? "docker" : raw["engine"];
  if (typeof engine !== "string" || !(CONTAINER_ENGINES as readonly string[]).includes(engine)) {
    return reject(`"sandbox.engine" must be one of ${CONTAINER_ENGINES.join(", ")}`);
  }

  const image = raw["image"];
  if (typeof image !== "string" || image.trim().length === 0) {
    return reject(`container mode requires a "sandbox.image" (host-configured, never from a client)`);
  }
  if (image.length > 256 || !IMAGE_PATTERN.test(image)) {
    return reject(`"sandbox.image" is not a valid image reference (lowercase repo[:tag][@sha256:digest]; no flags/whitespace/metacharacters)`);
  }

  const workspace = raw["containerWorkspace"] === undefined ? "/workspace" : raw["containerWorkspace"];
  if (
    typeof workspace !== "string" ||
    !CONTAINER_WORKSPACE_PATTERN.test(workspace) ||
    workspace.includes("..") ||
    workspace === "/"
  ) {
    return reject(`"sandbox.containerWorkspace" must be a plain absolute container path (no "..", ":", ",", or metacharacters)`);
  }

  const mount = raw["workspaceMount"] === undefined ? "readwrite" : raw["workspaceMount"];
  if (mount !== "readwrite" && mount !== "readonly") {
    return reject(`"sandbox.workspaceMount" must be "readwrite" or "readonly"`);
  }

  if (raw["memoryLimit"] !== undefined && (typeof raw["memoryLimit"] !== "string" || !MEMORY_LIMIT_PATTERN.test(raw["memoryLimit"]))) {
    return reject(`"sandbox.memoryLimit" must be a docker-style size string like "512m" or "1g"`);
  }
  const cpuRaw = raw["cpuLimit"];
  let cpuLimit: string | undefined;
  if (cpuRaw !== undefined) {
    const asString = typeof cpuRaw === "number" && Number.isFinite(cpuRaw) && cpuRaw > 0 ? String(cpuRaw) : cpuRaw;
    if (typeof asString !== "string" || !CPU_LIMIT_PATTERN.test(asString) || Number(asString) <= 0) {
      return reject(`"sandbox.cpuLimit" must be a positive number like "1" or "1.5"`);
    }
    cpuLimit = asString;
  }
  const pidsRaw = raw["pidsLimit"];
  const pidsLimit = pidsRaw === undefined ? 128 : pidsRaw;
  if (typeof pidsLimit !== "number" || !Number.isInteger(pidsLimit) || pidsLimit <= 0 || pidsLimit > MAX_PIDS_LIMIT) {
    return reject(`"sandbox.pidsLimit" must be a positive integer (≤ ${MAX_PIDS_LIMIT})`);
  }

  for (const key of ["readOnlyRootFilesystem", "dropCapabilities", "noNewPrivileges"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      return reject(`"sandbox.${key}" must be a boolean`);
    }
  }

  if (raw["user"] !== undefined && (typeof raw["user"] !== "string" || !CONTAINER_USER_PATTERN.test(raw["user"]))) {
    return reject(`"sandbox.user" must be a user name or uid[:gid] token`);
  }

  return {
    ok: true,
    config: {
      engine: engine as ContainerEngine,
      image,
      containerWorkspace: workspace,
      workspaceMountReadonly: mount === "readonly",
      ...(raw["memoryLimit"] !== undefined ? { memoryLimit: raw["memoryLimit"] as string } : {}),
      ...(cpuLimit !== undefined ? { cpuLimit } : {}),
      pidsLimit,
      readOnlyRootFilesystem: raw["readOnlyRootFilesystem"] !== false, // default true
      dropCapabilities: raw["dropCapabilities"] !== false, // default true
      noNewPrivileges: raw["noNewPrivileges"] !== false, // default true
      ...(raw["user"] !== undefined ? { user: raw["user"] as string } : {}),
    },
  };
}

/** Whether `mode` can actually be enforced on this host right now. */
export function isSandboxModeSupported(
  mode: SandboxMode,
  opts?: {
    sandboxExecOverride?: boolean;
    containerEngine?: ContainerEngine;
    containerEngineOverride?: string | null;
  },
): boolean {
  switch (mode) {
    case "none":
    case "restricted-process":
      // Neither enforces an OS boundary, so both are trivially "supported"
      // everywhere — `restricted-process` just applies process hygiene.
      return true;
    case "sandbox-exec":
      return sandboxExecAvailable(opts?.sandboxExecOverride);
    case "container":
      return (
        resolveContainerEngineExecutable(opts?.containerEngine ?? "docker", opts?.containerEngineOverride) !== null
      );
  }
}

/**
 * Resolve a declared `SandboxPolicy` against this host into a `ResolvedSandbox`,
 * applying the fail-closed / downgrade rules:
 *
 * - supported mode → used as-is (container mode additionally resolves and
 *   stores the engine client executable).
 * - unsupported + `required: true` → `mustReject: true` (loader drops the entry).
 * - unsupported + `required: false` → downgraded to `none`, `downgraded: true`.
 */
export function resolveSandboxPolicy(
  policy: SandboxPolicy,
  opts?: { sandboxExecOverride?: boolean; containerEngineOverride?: string | null },
): ResolvedSandbox {
  const unsupported = (): ResolvedSandbox => ({
    requestedMode: policy.mode,
    // Downgrade to `none` regardless; if `required`, `mustReject` makes the
    // loader drop the entry before it can ever be used with this effectiveMode.
    effectiveMode: "none",
    required: policy.required,
    allowNetwork: policy.allowNetwork,
    allowedWorkingDirectoryOnly: policy.allowedWorkingDirectoryOnly,
    supported: false,
    downgraded: true,
    mustReject: policy.required,
  });

  if (policy.mode === "container") {
    // `agentConfig.ts` guarantees `policy.container` exists for container mode;
    // if that invariant is ever violated, fail closed rather than run less
    // confined than declared.
    if (!policy.container) {
      return unsupported();
    }
    const engineExecutable = resolveContainerEngineExecutable(
      policy.container.engine,
      opts?.containerEngineOverride,
    );
    if (engineExecutable === null) {
      return unsupported();
    }
    return {
      requestedMode: "container",
      effectiveMode: "container",
      required: policy.required,
      allowNetwork: policy.allowNetwork,
      allowedWorkingDirectoryOnly: policy.allowedWorkingDirectoryOnly,
      supported: true,
      downgraded: false,
      mustReject: false,
      container: { ...policy.container, engineExecutable },
    };
  }

  if (isSandboxModeSupported(policy.mode, opts)) {
    return {
      requestedMode: policy.mode,
      effectiveMode: policy.mode,
      required: policy.required,
      allowNetwork: policy.allowNetwork,
      allowedWorkingDirectoryOnly: policy.allowedWorkingDirectoryOnly,
      supported: true,
      downgraded: false,
      mustReject: false,
    };
  }

  return unsupported();
}

/**
 * Escape a filesystem path for inclusion in a double-quoted `sandbox-exec`
 * profile string literal. macOS paths rarely contain quotes or backslashes,
 * but escape them defensively so a `"` in a directory name can't break out of
 * the literal and alter the profile.
 */
function escapeForProfile(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a macOS `sandbox-exec` profile that:
 * - allows everything by default (a plain CLI must read its own binary, dylibs,
 *   and the project tree — reads are intentionally NOT confined, see docs),
 * - then denies all filesystem writes and re-allows them ONLY under the working
 *   directory (plus `/dev/null`) when `allowedWorkingDirectoryOnly` is set, and
 * - denies all network when `allowNetwork` is false.
 *
 * Deliberately strict: it does NOT broadly allow system temp
 * (`/tmp`, `/var/folders`). Allowing temp would mean a working directory
 * located *inside* temp has its siblings/parents writable too, silently
 * weakening the "confined to the working directory" guarantee (a real footgun
 * observed in testing). A CLI that genuinely needs scratch space must therefore
 * write it under its own working directory; a future `writablePaths` option
 * could relax this per config (see docs/PHASE4_5_RUNTIME_SANDBOXING.md).
 *
 * `workingDirectory` is resolved to its realpath because the kernel matches
 * sandbox `subpath` rules against canonical paths (e.g. `/tmp` → `/private/tmp`),
 * so an un-canonicalized path would silently fail to match and deny even
 * in-directory writes.
 */
export function buildSandboxExecProfile(
  workingDirectory: string,
  opts: {
    allowNetwork: boolean;
    allowedWorkingDirectoryOnly: boolean;
    additionalWritablePaths?: readonly string[];
  },
): string {
  let realWorkDir: string;
  try {
    realWorkDir = fs.realpathSync(workingDirectory);
  } catch {
    // If it can't be resolved (shouldn't happen — the loader already checked it
    // exists), fall back to the given path rather than throwing here.
    realWorkDir = workingDirectory;
  }

  const lines = ["(version 1)", "(allow default)"];

  if (opts.allowedWorkingDirectoryOnly) {
    const additionalWritablePaths = Array.from(
      new Set(
        (opts.additionalWritablePaths ?? []).map((candidate) => {
          try {
            return fs.realpathSync(candidate);
          } catch {
            return candidate;
          }
        }),
      ),
    ).filter((candidate) => candidate !== realWorkDir);
    lines.push(
      "(deny file-write*)",
      "(allow file-write*",
      `  (subpath "${escapeForProfile(realWorkDir)}")`,
      ...additionalWritablePaths.map(
        (candidate) => `  (subpath "${escapeForProfile(candidate)}")`,
      ),
      '  (literal "/dev/null"))',
    );
  }

  if (!opts.allowNetwork) {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

/** Docker/Podman container name charset (also what we generate from session ids). */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;

/**
 * Build the exact `<engine> run …` argv for a container-sandboxed session.
 * **Pure** (aside from a realpath lookup) and argv-only: the result feeds
 * `child_process.spawn(executable, args, { shell: false })` directly — no
 * shell string is ever assembled, so nothing in the config can be
 * shell-interpreted, and quoting bugs are structurally impossible.
 *
 * Safety properties, by construction:
 * - The ONLY volume mount is `<workingDirectory realpath>:<containerWorkspace>`
 *   (`:ro` when `workspaceMountReadonly`). There is no input that can add a
 *   second mount, so the Docker socket / home / system paths can never be
 *   mounted here (the working directory itself is separately validated in
 *   `agentConfig.ts`).
 * - Environment is forwarded with `-e KEY` (key-only): the engine client reads
 *   the value from its own environment, so secret **values never appear in
 *   argv** (`ps`-safe). Keys are filtered to valid env names and the pairing
 *   token is dropped even if (mistakenly) allowlisted.
 * - `--network none` unless `allowNetwork` is explicitly true.
 * - Everything after the image is the container's command vector — the engine
 *   parses no flags there, so command/args are inert data.
 *
 * The same argv shape works for both docker and podman (podman's CLI is
 * docker-compatible for every flag used here).
 */
export function buildContainerArgv(params: {
  container: ContainerSandboxConfig & { engineExecutable: string };
  allowNetwork: boolean;
  workingDirectory: string;
  command: string;
  args: string[];
  /** Env keys to forward into the container (`-e KEY` form). Filtered here as a second line of defense. */
  envPassthroughKeys: string[];
  /** `--name` for the container, so stop/cleanup can target it. */
  containerName: string;
}): { executable: string; args: string[] } {
  const c = params.container;

  let realWorkDir: string;
  try {
    realWorkDir = fs.realpathSync(params.workingDirectory);
  } catch {
    realWorkDir = params.workingDirectory;
  }

  const name = CONTAINER_NAME_PATTERN.test(params.containerName)
    ? params.containerName
    : "orbitory-session";

  const argv: string[] = ["run", "--rm", "-i", "--name", name];

  if (!params.allowNetwork) {
    argv.push("--network", "none");
  }
  if (c.memoryLimit !== undefined) {
    argv.push("--memory", c.memoryLimit);
  }
  if (c.cpuLimit !== undefined) {
    argv.push("--cpus", c.cpuLimit);
  }
  argv.push("--pids-limit", String(c.pidsLimit));
  if (c.readOnlyRootFilesystem) {
    // A read-only root needs a scratch dir for ordinary programs; tmpfs is
    // container-private and vanishes with it.
    argv.push("--read-only", "--tmpfs", "/tmp");
  }
  if (c.dropCapabilities) {
    argv.push("--cap-drop", "ALL");
  }
  if (c.noNewPrivileges) {
    argv.push("--security-opt", "no-new-privileges");
  }
  if (c.user !== undefined) {
    argv.push("--user", c.user);
  }
  argv.push("--workdir", c.containerWorkspace);
  argv.push("-v", `${realWorkDir}:${c.containerWorkspace}:${c.workspaceMountReadonly ? "ro" : "rw"}`);

  for (const key of params.envPassthroughKeys) {
    if (key === "ORBITORY_PAIRING_TOKEN" || !ENV_NAME_PATTERN.test(key)) {
      continue;
    }
    argv.push("-e", key);
  }

  argv.push(c.image, params.command, ...params.args);

  return { executable: c.engineExecutable, args: argv };
}

/**
 * Given the configured command/args and a resolved sandbox, return the
 * command/args to actually spawn, plus whether the child should be spawned
 * detached (its own process group).
 *
 * - `none` → spawn as-is, not detached (byte-identical to pre-4.5 behavior).
 * - `restricted-process` → spawn as-is, detached (group isolation only).
 * - `sandbox-exec` → wrap in `/usr/bin/sandbox-exec -p <profile> <command> …`,
 *   detached.
 * - `container` → wrap in `<engine> run … <image> <command> …` via
 *   `buildContainerArgv`, detached. Requires `containerOpts`; the provider
 *   fails the session closed before calling this if the container invariants
 *   don't hold.
 */
export function wrapCommandForSandbox(
  command: string,
  args: string[],
  sandbox: ResolvedSandbox,
  workingDirectory: string,
  containerOpts?: { envPassthroughKeys: string[]; containerName: string },
  additionalWritablePaths: readonly string[] = [],
): { command: string; args: string[]; detached: boolean } {
  switch (sandbox.effectiveMode) {
    case "none":
      return { command, args, detached: false };
    case "restricted-process":
      return { command, args, detached: true };
    case "sandbox-exec": {
      const profile = buildSandboxExecProfile(workingDirectory, {
        allowNetwork: sandbox.allowNetwork,
        allowedWorkingDirectoryOnly: sandbox.allowedWorkingDirectoryOnly,
        additionalWritablePaths,
      });
      return {
        command: "/usr/bin/sandbox-exec",
        args: ["-p", profile, command, ...args],
        detached: true,
      };
    }
    case "container": {
      if (!sandbox.container || !containerOpts) {
        // Programming-error path (the provider guards before calling): fail
        // loudly rather than silently running less confined than declared.
        throw new Error("container sandbox mode requires resolved container settings");
      }
      const launch = buildContainerArgv({
        container: sandbox.container,
        allowNetwork: sandbox.allowNetwork,
        workingDirectory,
        command,
        args,
        envPassthroughKeys: containerOpts.envPassthroughKeys,
        containerName: containerOpts.containerName,
      });
      return { command: launch.executable, args: launch.args, detached: true };
    }
  }
}

/**
 * A short, human-readable, non-localized description of the effective sandbox,
 * emitted to the terminal stream at session start so a human watching Live can
 * see exactly what isolation is (or is not) in effect. Deliberately blunt about
 * `none` / `restricted-process` NOT being real boundaries.
 */
export function describeSandbox(
  sandbox: ResolvedSandbox,
  options: { providerStateWrites?: boolean } = {},
): string {
  const downgradeNote = sandbox.downgraded
    ? ` requested "${sandbox.requestedMode}" is unavailable on this host, so it was downgraded;`
    : "";

  switch (sandbox.effectiveMode) {
    case "container": {
      const c = sandbox.container;
      if (!c) {
        // Invariant violation — never claim isolation that can't be described.
        return "[orbitory] sandbox: container (MISCONFIGURED — missing container settings).";
      }
      const parts: string[] = [
        c.engine,
        `image ${c.image}`,
        `workspace ${c.workspaceMountReadonly ? "read-only" : "read-write"} at ${c.containerWorkspace}`,
        sandbox.allowNetwork ? "network ALLOWED" : "network denied",
        `pids ${c.pidsLimit}`,
      ];
      if (c.memoryLimit) parts.push(`mem ${c.memoryLimit}`);
      if (c.cpuLimit) parts.push(`cpus ${c.cpuLimit}`);
      if (c.readOnlyRootFilesystem) parts.push("read-only root");
      return `[orbitory] sandbox: container (${parts.join("; ")}).`;
    }
    case "sandbox-exec": {
      const parts: string[] = [];
      if (sandbox.allowedWorkingDirectoryOnly) {
        parts.push(
          options.providerStateWrites
            ? "writes confined to the working directory plus provider state"
            : "writes confined to the working directory",
        );
      }
      parts.push(sandbox.allowNetwork ? "network allowed" : "network denied");
      return `[orbitory] sandbox: sandbox-exec (${parts.join("; ")}; reads NOT confined — best-effort, see docs/security.md).`;
    }
    case "restricted-process":
      return "[orbitory] sandbox: restricted-process (own process group only; NOT a filesystem or network boundary).";
    case "none":
    default:
      return `[orbitory] sandbox: none (unsandboxed — runs with host-agent privileges;${downgradeNote} see docs/security.md).`;
  }
}
