/**
 * Host-authoritative project and provider resume catalog.
 *
 * Paths and provider thread/session ids remain in this process. The iOS client receives
 * only random opaque handles plus short display labels. Configured projects
 * are always listed; Codex history is added only after explicit host-local
 * opt-in in orbitory.config.json.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  agentConfigs,
  loadCodexHistoryDiscoveryConfig,
  loadProjectCreationConfig,
  loadProviderDescriptors,
  refreshAgentConfigs,
  type ProjectCreationConfig,
  type TerminalAgentConfig,
} from "./agentConfig.js";
import { queryClaudeSessions } from "./claudeHistory.js";
import { buildSandboxExecProfile, wrapCommandForSandbox } from "./sandbox.js";
import type {
  ProjectDescriptor,
  ProjectCreationCapability,
  ProjectsSnapshotPayload,
  ProviderDescriptor,
  ResumableSessionDescriptor,
  RiskLevel,
} from "./types.js";

const CATALOG_CACHE_MS = 15_000;
const APP_SERVER_INITIALIZE_TIMEOUT_MS = 8_000;
const APP_SERVER_THREAD_LIST_TIMEOUT_MS = 20_000;
const MAX_APP_SERVER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DISPLAY_NAME_CHARS = 80;
const MAX_RESUME_TITLE_CHARS = 120;
export const PROJECT_NAME_MAX_LENGTH = 64;
const CREATED_PROJECT_MARKER = ".orbitory-project.json";
const CREATED_PROJECT_MARKER_MAX_BYTES = 1_024;
const CODEX_HISTORY_DIRECTORIES = ["sessions", "archived_sessions"] as const;
const CATALOG_ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

interface CodexThreadRecord {
  id: string;
  cwd: string;
  name: string | null;
  updatedAt: number;
  parentThreadId?: string | null;
}

interface ProjectLaunchTarget {
  providerId: string;
  workingDirectory: string;
  kind: "configured" | "codex_history" | "claude_history" | "created";
  configuredWorkingDirectory: string;
}

type ResumeTarget =
  | { kind: "codex"; projectId: string; providerId: string; codexThreadId: string }
  | { kind: "claude"; projectId: string; providerId: string; claudeSessionId: string };

interface ProjectRow {
  directory: string;
  providerIds: Set<string>;
  warnings: Set<string>;
  risks: RiskLevel[];
  resumeCount: number;
  preferredProviderId?: string;
}

interface CreatedProjectRecord {
  directory: string;
  preferredProviderId?: string;
  requestId?: string;
}

export type ProjectCreationResult =
  | { ok: true; project: ProjectDescriptor; snapshot: ProjectsSnapshotPayload }
  | { ok: false; code: string; message: string };

export interface ResolvedProjectLaunch {
  config: TerminalAgentConfig;
  codexThreadId?: string;
  claudeSessionId?: string;
}

function opaqueId(prefix: "project" | "resume"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function canonicalDirectory(value: string): string | undefined {
  if (!path.isAbsolute(value)) return undefined;
  try {
    const resolved = fs.realpathSync(value);
    if (!fs.statSync(resolved).isDirectory()) return undefined;
    if (resolved === path.parse(resolved).root) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function oneLine(value: string, maxChars: number): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function projectDisplayName(workingDirectory: string): string {
  return oneLine(path.basename(workingDirectory), MAX_DISPLAY_NAME_CHARS) || "Project";
}

function resumeTitle(name: string | null): string {
  if (typeof name !== "string" || name.trim().length === 0) return "Codex session";
  return oneLine(name, MAX_RESUME_TITLE_CHARS);
}

function riskRank(value: RiskLevel): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function highestRisk(values: RiskLevel[]): RiskLevel {
  return values.reduce<RiskLevel>(
    (highest, current) => (riskRank(current) > riskRank(highest) ? current : highest),
    "low",
  );
}

function cloneSnapshot(snapshot: ProjectsSnapshotPayload): ProjectsSnapshotPayload {
  return {
    projects: snapshot.projects.map((project) => ({
      ...project,
      providerIds: [...project.providerIds],
      warnings: [...project.warnings],
    })),
    resumableSessions: snapshot.resumableSessions.map((session) => ({ ...session })),
    ...(snapshot.creation
      ? { creation: { ...snapshot.creation, providerIds: [...snapshot.creation.providerIds] } }
      : { creation: null }),
  };
}

export function normalizeProjectName(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > PROJECT_NAME_MAX_LENGTH) return undefined;
  if (normalized === "." || normalized === ".." || normalized.startsWith(".")) return undefined;
  if (normalized.endsWith(".") || normalized.endsWith(" ")) return undefined;
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized)) return undefined;
  return normalized;
}

function markerPath(directory: string): string {
  return path.join(directory, CREATED_PROJECT_MARKER);
}

function readCreatedProjectMarker(
  directory: string,
): { preferredProviderId?: string; requestId?: string } | undefined {
  const marker = markerPath(directory);
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CREATED_PROJECT_MARKER_MAX_BYTES) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    if (raw["version"] !== 1 || raw["createdBy"] !== "Orbitory") return undefined;
    const preferredProviderId = raw["preferredProviderId"];
    const requestId = raw["requestId"];
    return {
      ...(typeof preferredProviderId === "string" && preferredProviderId.length <= 128
        ? { preferredProviderId }
        : {}),
      ...(typeof requestId === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(requestId)
        ? { requestId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function listCreatedProjects(config: ProjectCreationConfig): CreatedProjectRecord[] {
  const records: CreatedProjectRecord[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.rootDirectory, { withFileTypes: true });
  } catch {
    return records;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (records.length >= config.maxProjects) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(config.rootDirectory, entry.name);
    const marker = readCreatedProjectMarker(directory);
    if (!marker) continue;
    const canonical = canonicalDirectory(directory);
    if (!canonical || path.dirname(canonical) !== config.rootDirectory) continue;
    records.push({ directory: canonical, ...marker });
  }
  return records;
}

function creationProviders(config: ProjectCreationConfig): TerminalAgentConfig[] {
  return config.providerIds.flatMap((providerId) => {
    const provider = agentConfigs.get(providerId);
    if (!provider) return [];
    const supported =
      (provider.agentType === "codex" && provider.io === "codex-jsonl") ||
      (provider.agentType === "claudeCode" && provider.io === "stream-json");
    return supported ? [provider] : [];
  });
}

function creationCapability(config: ProjectCreationConfig | undefined): ProjectCreationCapability | null {
  if (!config) return null;
  const providerIds = creationProviders(config).map((provider) => provider.id);
  return providerIds.length > 0 ? { providerIds, maxNameLength: PROJECT_NAME_MAX_LENGTH } : null;
}

function isRegisteredCreatedProject(directory: string, config: ProjectCreationConfig): boolean {
  const canonical = canonicalDirectory(directory);
  return (
    canonical !== undefined &&
    path.dirname(canonical) === config.rootDirectory &&
    readCreatedProjectMarker(canonical) !== undefined
  );
}

function safeKill(child: ChildProcess, detached: boolean): void {
  try {
    if (detached && child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Best-effort cleanup of the short-lived read-only catalog helper.
  }
}

interface PreparedCodexCatalogHome {
  directory: string;
  cleanup: () => void;
}

function resolveSourceCodexHome(): string | undefined {
  const configured = process.env["CODEX_HOME"]?.trim();
  const candidate = configured && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), ".codex");
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Give app-server writable state without granting writes to the user's real
 * Codex home. Only the session directories are linked for read access; auth,
 * config, databases, logs, memories, and other home files are not copied.
 */
function prepareCodexCatalogHome(): PreparedCodexCatalogHome | undefined {
  const sourceHome = resolveSourceCodexHome();
  if (!sourceHome) return undefined;

  let directory: string;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-codex-catalog-"));
    fs.chmodSync(directory, 0o700);
  } catch {
    return undefined;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS temp directory remains private to the user.
    }
  };

  try {
    for (const name of CODEX_HISTORY_DIRECTORIES) {
      const source = path.join(sourceHome, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
      fs.symlinkSync(source, path.join(directory, name), process.platform === "win32" ? "junction" : "dir");
    }
    return { directory, cleanup };
  } catch {
    cleanup();
    return undefined;
  }
}

function buildCatalogChildEnv(catalogHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: catalogHome,
    HOME: catalogHome,
    USERPROFILE: catalogHome,
    XDG_CONFIG_HOME: catalogHome,
    XDG_DATA_HOME: catalogHome,
    XDG_CACHE_HOME: catalogHome,
    TMPDIR: catalogHome,
    TEMP: catalogHome,
    TMP: catalogHome,
  };
  for (const key of CATALOG_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function buildCatalogLaunch(
  config: TerminalAgentConfig,
  catalogHome: string,
): { command: string; args: string[]; detached: boolean } {
  const args = ["app-server", "--listen", "stdio://"];

  // On macOS, cataloging always uses a tighter, network-off profile even when
  // the provider itself is configured without sandboxing. Writes are allowed
  // only inside the disposable CODEX_HOME; symlink targets are canonicalized
  // by sandbox-exec, so the real sessions remain read-only.
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const profile = buildSandboxExecProfile(catalogHome, {
      allowNetwork: false,
      allowedWorkingDirectoryOnly: true,
    });
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", profile, config.command, ...args],
      detached: true,
    };
  }

  return wrapCommandForSandbox(
    config.command,
    args,
    { ...config.sandbox, allowNetwork: false },
    catalogHome,
  );
}

/**
 * Query only `initialize` and `thread/list` on Codex app-server over stdio.
 * No filesystem/config/shell method is accepted or emitted by this client.
 */
export function queryCodexThreads(
  config: TerminalAgentConfig,
  maxSessions: number,
): Promise<CodexThreadRecord[]> {
  return new Promise((resolve) => {
    // A workspace-only container cannot safely read the host's Codex history.
    // Fail closed instead of weakening the configured sandbox or mounting HOME.
    if (config.sandbox.effectiveMode === "container") {
      resolve([]);
      return;
    }

    const catalogHome = prepareCodexCatalogHome();
    if (!catalogHome) {
      resolve([]);
      return;
    }

    let launch: ReturnType<typeof buildCatalogLaunch>;
    try {
      launch = buildCatalogLaunch(config, catalogHome.directory);
    } catch {
      catalogHome.cleanup();
      resolve([]);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: config.workingDirectory,
        env: buildCatalogChildEnv(catalogHome.directory),
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
        detached: launch.detached,
      });
    } catch {
      catalogHome.cleanup();
      resolve([]);
      return;
    }

    let settled = false;
    let stdoutBuffer = "";
    let outputBytes = 0;
    const finish = (threads: CodexThreadRecord[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeKill(child, launch.detached);
      const cleanupFallback = setTimeout(catalogHome.cleanup, 2_000);
      cleanupFallback.unref();
      resolve(threads);
    };
    let timer = setTimeout(() => finish([]), APP_SERVER_INITIALIZE_TIMEOUT_MS);

    child.on("error", () => finish([]));
    // `close` fires after stdio is drained; `exit` can race the final response.
    child.on("close", () => {
      finish([]);
      catalogHome.cleanup();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_APP_SERVER_OUTPUT_BYTES) {
        finish([]);
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (!line) continue;

        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
        const record = message as Record<string, unknown>;

        if (record["id"] === 1 && record["result"] !== undefined) {
          clearTimeout(timer);
          timer = setTimeout(() => finish([]), APP_SERVER_THREAD_LIST_TIMEOUT_MS);
          child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "thread/list",
              params: {
                limit: maxSessions,
                sortKey: "updated_at",
                sortDirection: "desc",
                archived: false,
              },
            })}\n`,
          );
          continue;
        }

        if (record["id"] !== 2) continue;
        const result = record["result"];
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          finish([]);
          return;
        }
        const data = (result as Record<string, unknown>)["data"];
        if (!Array.isArray(data)) {
          finish([]);
          return;
        }
        const threads: CodexThreadRecord[] = [];
        for (const raw of data) {
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
          const thread = raw as Record<string, unknown>;
          if (
            typeof thread["id"] !== "string" ||
            typeof thread["cwd"] !== "string" ||
            typeof thread["updatedAt"] !== "number"
          ) {
            continue;
          }
          const parentThreadId = thread["parentThreadId"];
          if (typeof parentThreadId === "string" && parentThreadId.length > 0) continue;
          if (thread["ephemeral"] === true) continue;
          const threadSource = thread["threadSource"];
          if (threadSource === "subagent" || threadSource === "memory_consolidation") continue;
          threads.push({
            id: thread["id"],
            cwd: thread["cwd"],
            name: typeof thread["name"] === "string" ? thread["name"] : null,
            updatedAt: thread["updatedAt"],
            parentThreadId: typeof parentThreadId === "string" ? parentThreadId : null,
          });
        }
        finish(threads.slice(0, maxSessions));
        return;
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "orbitory-host", title: "Orbitory", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}

export class ProjectCatalog {
  private readonly projectIdsByDirectory = new Map<string, string>();
  private readonly resumeIdsByProviderSession = new Map<string, string>();
  private launchTargets = new Map<string, Map<string, ProjectLaunchTarget>>();
  private resumeTargets = new Map<string, ResumeTarget>();
  private currentSnapshot: ProjectsSnapshotPayload = { projects: [], resumableSessions: [] };
  private refreshedAt = 0;
  private refreshPromise: Promise<ProjectsSnapshotPayload> | null = null;
  private readonly creationRequests = new Map<
    string,
    { name: string; providerId: string; directory: string }
  >();

  async snapshot(force = false): Promise<ProjectsSnapshotPayload> {
    if (!force && Date.now() - this.refreshedAt < CATALOG_CACHE_MS) {
      return cloneSnapshot(this.currentSnapshot);
    }
    if (this.refreshPromise) return cloneSnapshot(await this.refreshPromise);

    this.refreshPromise = this.buildSnapshot();
    try {
      this.currentSnapshot = await this.refreshPromise;
      this.refreshedAt = Date.now();
      return cloneSnapshot(this.currentSnapshot);
    } finally {
      this.refreshPromise = null;
    }
  }

  async createProject(
    requestId: string,
    rawName: string,
    providerId: string,
  ): Promise<ProjectCreationResult> {
    refreshAgentConfigs();
    const config = loadProjectCreationConfig();
    const capability = creationCapability(config);
    if (!config || !capability) {
      return {
        ok: false,
        code: "project_creation_disabled",
        message: "Project creation is not enabled on this host.",
      };
    }
    if (!capability.providerIds.includes(providerId)) {
      return {
        ok: false,
        code: "project_provider_unavailable",
        message: "The selected provider is not enabled for new projects.",
      };
    }
    const name = normalizeProjectName(rawName);
    if (!name) {
      return {
        ok: false,
        code: "invalid_project_name",
        message: `Project names must be 1-${PROJECT_NAME_MAX_LENGTH} characters and cannot contain path or reserved characters.`,
      };
    }

    const registered = listCreatedProjects(config);
    const persisted = registered.find((project) => project.requestId === requestId);
    const previous = this.creationRequests.get(requestId);
    if (previous && (previous.name !== name || previous.providerId !== providerId)) {
      return {
        ok: false,
        code: "request_id_conflict",
        message: "This project request id was already used with different values.",
      };
    }
    if (
      persisted &&
      (path.basename(persisted.directory) !== name ||
        persisted.preferredProviderId !== providerId)
    ) {
      return {
        ok: false,
        code: "request_id_conflict",
        message: "This project request id was already used with different values.",
      };
    }

    const target =
      previous?.directory ?? persisted?.directory ?? path.join(config.rootDirectory, name);
    if (path.dirname(target) !== config.rootDirectory) {
      return { ok: false, code: "invalid_project_name", message: "Invalid project name." };
    }

    if (!previous) {
      if (fs.existsSync(target)) {
        const marker = readCreatedProjectMarker(target);
        if (
          !isRegisteredCreatedProject(target, config) ||
          marker?.requestId !== requestId ||
          marker.preferredProviderId !== providerId
        ) {
          return {
            ok: false,
            code: "project_already_exists",
            message: "A project or folder with that name already exists.",
          };
        }
      } else {
        if (registered.length >= config.maxProjects) {
          return {
            ok: false,
            code: "project_limit_reached",
            message: "This host has reached its Orbitory-created project limit.",
          };
        }
        let stagingDirectory: string | null = null;
        let targetCreated = false;
        try {
          // Build the marker privately inside the authorized root. Reserve the
          // final direct child with non-recursive mkdir (atomic EEXIST), then
          // move only our marker into it. We never replace or follow a
          // pre-existing path supplied by the phone.
          stagingDirectory = fs.mkdtempSync(
            path.join(config.rootDirectory, ".orbitory-create-"),
          );
          fs.chmodSync(stagingDirectory, 0o700);
          fs.writeFileSync(
            markerPath(stagingDirectory),
            `${JSON.stringify({
              version: 1,
              createdBy: "Orbitory",
              preferredProviderId: providerId,
              requestId,
            })}\n`,
            { mode: 0o600, flag: "wx" },
          );
          fs.mkdirSync(target, { mode: 0o700 });
          targetCreated = true;
          fs.renameSync(markerPath(stagingDirectory), markerPath(target));
          try {
            fs.rmdirSync(stagingDirectory);
          } catch {
            // The empty private staging directory is best-effort cleanup.
          }
          stagingDirectory = null;
        } catch {
          if (stagingDirectory) {
            try {
              fs.rmSync(stagingDirectory, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup of our own 0700 staging directory only.
            }
          }
          if (targetCreated) {
            try {
              // Removes only an empty directory that this request reserved.
              // If anything appeared inside it concurrently, preserve it.
              fs.rmdirSync(target);
            } catch {
              // Preserve any concurrently populated directory.
            }
          }
          return {
            ok: false,
            code: "project_creation_failed",
            message: "The host could not create the project directory.",
          };
        }
      }
      this.creationRequests.set(requestId, { name, providerId, directory: target });
    }

    this.refreshedAt = 0;
    const snapshot = await this.snapshot(true);
    const canonicalTarget = canonicalDirectory(target);
    const projectId = canonicalTarget
      ? this.projectIdsByDirectory.get(canonicalTarget)
      : undefined;
    const project = projectId
      ? snapshot.projects.find((candidate) => candidate.id === projectId)
      : undefined;
    if (!project) {
      return {
        ok: false,
        code: "project_creation_failed",
        message: "The project was created but could not be added to the catalog.",
      };
    }
    return { ok: true, project, snapshot };
  }

  resolveLaunch(
    projectId: string,
    providerId: string,
    resumeId?: string,
  ): ResolvedProjectLaunch | undefined {
    refreshAgentConfigs();
    const baseConfig = agentConfigs.get(providerId);
    const target = this.launchTargets.get(projectId)?.get(providerId);
    if (!baseConfig || !target) return undefined;

    if (
      target.kind === "configured" &&
      baseConfig.workingDirectory !== target.configuredWorkingDirectory
    ) {
      return undefined;
    }
    if (
      target.kind === "codex_history" ||
      target.kind === "claude_history" ||
      resumeId !== undefined
    ) {
      const discovery = loadCodexHistoryDiscoveryConfig();
      if (
        !discovery ||
        !new Set([discovery.providerId, ...discovery.additionalProviderIds]).has(providerId)
      ) {
        return undefined;
      }
    }
    if (target.kind === "created") {
      const creation = loadProjectCreationConfig();
      if (
        !creation ||
        !creation.providerIds.includes(providerId) ||
        !isRegisteredCreatedProject(target.workingDirectory, creation)
      ) {
        return undefined;
      }
    }

    let codexThreadId: string | undefined;
    let claudeSessionId: string | undefined;
    if (resumeId !== undefined) {
      const resume = this.resumeTargets.get(resumeId);
      if (!resume || resume.projectId !== projectId || resume.providerId !== providerId) {
        return undefined;
      }
      if (resume.kind === "codex") {
        if (baseConfig.agentType !== "codex" || baseConfig.io !== "codex-jsonl") return undefined;
        codexThreadId = resume.codexThreadId;
      } else {
        if (baseConfig.agentType !== "claudeCode" || baseConfig.io !== "stream-json") return undefined;
        claudeSessionId = resume.claudeSessionId;
      }
    }

    return {
      config: { ...baseConfig, workingDirectory: target.workingDirectory },
      ...(codexThreadId ? { codexThreadId } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
  }

  private projectIdForDirectory(directory: string): string {
    const existing = this.projectIdsByDirectory.get(directory);
    if (existing) return existing;
    const id = opaqueId("project");
    this.projectIdsByDirectory.set(directory, id);
    return id;
  }

  private resumeIdForProviderSession(key: string): string {
    const existing = this.resumeIdsByProviderSession.get(key);
    if (existing) return existing;
    const id = opaqueId("resume");
    this.resumeIdsByProviderSession.set(key, id);
    return id;
  }

  private async buildSnapshot(): Promise<ProjectsSnapshotPayload> {
    refreshAgentConfigs();
    const descriptors = new Map(
      loadProviderDescriptors().map((provider) => [provider.id, provider] as const),
    );
    const projectRows = new Map<string, ProjectRow>();
    const launchTargets = new Map<string, Map<string, ProjectLaunchTarget>>();
    const resumeTargets = new Map<string, ResumeTarget>();
    const resumableSessions: ResumableSessionDescriptor[] = [];

    const ensureProject = (directory: string): [string, ProjectRow] => {
      const projectId = this.projectIdForDirectory(directory);
      let row = projectRows.get(projectId);
      if (!row) {
        row = {
          directory,
          providerIds: new Set(),
          warnings: new Set(),
          risks: [],
          resumeCount: 0,
        };
        projectRows.set(projectId, row);
      }
      return [projectId, row];
    };

    for (const config of agentConfigs.values()) {
      const directory = canonicalDirectory(config.workingDirectory);
      if (!directory) continue;
      const [projectId, row] = ensureProject(directory);
      row.providerIds.add(config.id);
      const descriptor = descriptors.get(config.id);
      if (descriptor) {
        row.risks.push(descriptor.riskLevel);
        descriptor.warnings.forEach((warning) => row.warnings.add(warning));
      }
      const targets = launchTargets.get(projectId) ?? new Map<string, ProjectLaunchTarget>();
      targets.set(config.id, {
        providerId: config.id,
        workingDirectory: directory,
        kind: "configured",
        configuredWorkingDirectory: config.workingDirectory,
      });
      launchTargets.set(projectId, targets);
    }

    const creation = loadProjectCreationConfig();
    const createdProviders = creation ? creationProviders(creation) : [];
    if (creation && createdProviders.length > 0) {
      for (const created of listCreatedProjects(creation)) {
        const [projectId, row] = ensureProject(created.directory);
        row.warnings.add("created_by_orbitory");
        if (created.preferredProviderId) {
          row.preferredProviderId = created.preferredProviderId;
        }
        const targets = launchTargets.get(projectId) ?? new Map<string, ProjectLaunchTarget>();
        for (const provider of createdProviders) {
          row.providerIds.add(provider.id);
          row.risks.push(descriptors.get(provider.id)?.riskLevel ?? "high");
          targets.set(provider.id, {
            providerId: provider.id,
            workingDirectory: created.directory,
            kind: "created",
            configuredWorkingDirectory: provider.workingDirectory,
          });
        }
        launchTargets.set(projectId, targets);
      }
    }

    const discovery = loadCodexHistoryDiscoveryConfig();
    if (discovery) {
      const template = agentConfigs.get(discovery.providerId);
      if (template?.agentType === "codex" && template.io === "codex-jsonl") {
        const historyProviders = [
          template,
          ...discovery.additionalProviderIds.flatMap((providerId) => {
            const provider = agentConfigs.get(providerId);
            return provider ? [provider] : [];
          }),
        ];
        const threads = await queryCodexThreads(template, discovery.maxSessions);
        for (const thread of threads) {
          const directory = canonicalDirectory(thread.cwd);
          if (!directory) continue;
          const [projectId, row] = ensureProject(directory);
          row.warnings.add("codex_history_experimental");
          row.warnings.add("broad_project_access");
          row.resumeCount += 1;

          const targets = launchTargets.get(projectId) ?? new Map<string, ProjectLaunchTarget>();
          for (const provider of historyProviders) {
            row.providerIds.add(provider.id);
            row.risks.push(descriptors.get(provider.id)?.riskLevel ?? "high");
            if (!targets.has(provider.id)) {
              targets.set(provider.id, {
                providerId: provider.id,
                workingDirectory: directory,
                kind: "codex_history",
                configuredWorkingDirectory: provider.workingDirectory,
              });
            }
          }
          launchTargets.set(projectId, targets);

          const resumeId = this.resumeIdForProviderSession(`codex:${template.id}:${thread.id}`);
          resumeTargets.set(resumeId, {
            kind: "codex",
            projectId,
            providerId: template.id,
            codexThreadId: thread.id,
          });
          resumableSessions.push({
            id: resumeId,
            projectId,
            providerId: template.id,
            title: resumeTitle(thread.name),
            agentType: "codex",
            updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
          });
        }

        const claudeProviders = historyProviders.filter(
          (provider) => provider.agentType === "claudeCode" && provider.io === "stream-json",
        );
        if (claudeProviders.length > 0) {
          const sessions = queryClaudeSessions(discovery.maxSessions);
          for (const provider of claudeProviders) {
            for (const session of sessions) {
              const directory = canonicalDirectory(session.cwd);
              if (!directory) continue;
              const [projectId, row] = ensureProject(directory);
              row.warnings.add("claude_history_experimental");
              row.warnings.add("broad_project_access");
              row.resumeCount += 1;
              row.providerIds.add(provider.id);
              row.risks.push(descriptors.get(provider.id)?.riskLevel ?? "high");

              const targets = launchTargets.get(projectId) ?? new Map<string, ProjectLaunchTarget>();
              if (!targets.has(provider.id)) {
                targets.set(provider.id, {
                  providerId: provider.id,
                  workingDirectory: directory,
                  kind: "claude_history",
                  configuredWorkingDirectory: provider.workingDirectory,
                });
              }
              launchTargets.set(projectId, targets);

              const resumeId = this.resumeIdForProviderSession(
                `claude:${provider.id}:${session.id}`,
              );
              resumeTargets.set(resumeId, {
                kind: "claude",
                projectId,
                providerId: provider.id,
                claudeSessionId: session.id,
              });
              resumableSessions.push({
                id: resumeId,
                projectId,
                providerId: provider.id,
                title: session.title,
                agentType: "claudeCode",
                updatedAt: session.updatedAt,
              });
            }
          }
        }
      }
    }

    const projects: ProjectDescriptor[] = Array.from(projectRows, ([id, row]) => {
      const providerIds = Array.from(row.providerIds);
      const startableProviderIds = providerIds.filter((providerId) => {
        const provider: ProviderDescriptor | undefined = descriptors.get(providerId);
        return provider?.startable === true;
      });
      return {
        id,
        hostId: os.hostname(),
        displayName: projectDisplayName(row.directory),
        providerIds,
        defaultProviderId:
          (row.preferredProviderId && startableProviderIds.includes(row.preferredProviderId)
            ? row.preferredProviderId
            : undefined) ??
          startableProviderIds[0] ??
          providerIds[0] ??
          null,
        startable: startableProviderIds.length > 0,
        riskLevel: highestRisk(row.risks),
        warnings: Array.from(row.warnings),
        resumableSessionCount: row.resumeCount,
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));

    resumableSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.launchTargets = launchTargets;
    this.resumeTargets = resumeTargets;
    return {
      projects,
      resumableSessions,
      creation: creationCapability(creation),
    };
  }
}

export const projectCatalog = new ProjectCatalog();
