/**
 * Host-authoritative project and Codex resume catalog.
 *
 * Paths and Codex thread ids remain in this process. The iOS client receives
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
  loadProviderDescriptors,
  refreshAgentConfigs,
  type TerminalAgentConfig,
} from "./agentConfig.js";
import { buildSandboxExecProfile, wrapCommandForSandbox } from "./sandbox.js";
import type {
  ProjectDescriptor,
  ProjectsSnapshotPayload,
  ProviderDescriptor,
  ResumableSessionDescriptor,
  RiskLevel,
} from "./types.js";

const CATALOG_CACHE_MS = 15_000;
const APP_SERVER_TIMEOUT_MS = 8_000;
const MAX_APP_SERVER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DISPLAY_NAME_CHARS = 80;
const MAX_RESUME_TITLE_CHARS = 120;
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
  kind: "configured" | "codex_history";
  configuredWorkingDirectory: string;
}

interface ResumeTarget {
  projectId: string;
  providerId: string;
  codexThreadId: string;
}

interface ProjectRow {
  directory: string;
  providerIds: Set<string>;
  warnings: Set<string>;
  risks: RiskLevel[];
  resumeCount: number;
}

export interface ResolvedProjectLaunch {
  config: TerminalAgentConfig;
  codexThreadId?: string;
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
  };
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
    const timer = setTimeout(() => finish([]), APP_SERVER_TIMEOUT_MS);

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
  private readonly resumeIdsByThread = new Map<string, string>();
  private launchTargets = new Map<string, Map<string, ProjectLaunchTarget>>();
  private resumeTargets = new Map<string, ResumeTarget>();
  private currentSnapshot: ProjectsSnapshotPayload = { projects: [], resumableSessions: [] };
  private refreshedAt = 0;
  private refreshPromise: Promise<ProjectsSnapshotPayload> | null = null;

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
    if (target.kind === "codex_history") {
      const discovery = loadCodexHistoryDiscoveryConfig();
      if (
        !discovery ||
        !new Set([discovery.providerId, ...discovery.additionalProviderIds]).has(providerId)
      ) {
        return undefined;
      }
    }

    let codexThreadId: string | undefined;
    if (resumeId !== undefined) {
      const resume = this.resumeTargets.get(resumeId);
      if (
        !resume ||
        resume.projectId !== projectId ||
        resume.providerId !== providerId ||
        baseConfig.agentType !== "codex" ||
        baseConfig.io !== "codex-jsonl"
      ) {
        return undefined;
      }
      codexThreadId = resume.codexThreadId;
    }

    return {
      config: { ...baseConfig, workingDirectory: target.workingDirectory },
      ...(codexThreadId ? { codexThreadId } : {}),
    };
  }

  private projectIdForDirectory(directory: string): string {
    const existing = this.projectIdsByDirectory.get(directory);
    if (existing) return existing;
    const id = opaqueId("project");
    this.projectIdsByDirectory.set(directory, id);
    return id;
  }

  private resumeIdForThread(threadId: string): string {
    const existing = this.resumeIdsByThread.get(threadId);
    if (existing) return existing;
    const id = opaqueId("resume");
    this.resumeIdsByThread.set(threadId, id);
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

          const resumeId = this.resumeIdForThread(thread.id);
          resumeTargets.set(resumeId, {
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
        defaultProviderId: startableProviderIds[0] ?? providerIds[0] ?? null,
        startable: startableProviderIds.length > 0,
        riskLevel: highestRisk(row.risks),
        warnings: Array.from(row.warnings),
        resumableSessionCount: row.resumeCount,
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));

    resumableSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.launchTargets = launchTargets;
    this.resumeTargets = resumeTargets;
    return { projects, resumableSessions };
  }
}

export const projectCatalog = new ProjectCatalog();
