import {
  createHash,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  AgentType,
  ProviderLaunchIntent,
  ProviderLaunchProfileDescriptor,
  ProviderModelOptionDescriptor,
  ProviderPermissionMode,
  ProviderPermissionProfileDescriptor,
  ProviderToolsetDescriptor,
} from "./types.js";

export interface ClaudeMcpServerRuntimeConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface RuntimeToolset {
  descriptor: ProviderToolsetDescriptor;
  skillNames: string[];
  claudeMcpServers: Record<string, ClaudeMcpServerRuntimeConfig>;
  secretLiterals: string[];
}

export interface ProviderControls {
  launchProfiles: ProviderLaunchProfileDescriptor[];
  models: ProviderModelOptionDescriptor[];
  permissionProfiles: ProviderPermissionProfileDescriptor[];
  toolsets: ProviderToolsetDescriptor[];
  /** Private freshness material. Never serialize or send to a client. */
  catalogDigest: string;
  runtimeToolsets: Map<string, RuntimeToolset>;
}

export interface ResolvedProviderSelection {
  launchProfileId: string;
  intent: ProviderLaunchIntent;
  modelId: string;
  modelCliValue?: string;
  permissionProfileId: string;
  permissionMode: ProviderPermissionMode;
  toolsetId: string;
  includesMcp: boolean;
  includesSkills: boolean;
  skillNames: string[];
  claudeMcpServers: Record<string, ClaudeMcpServerRuntimeConfig>;
  /** MCP env values to scrub if a child echoes them. Host-only. */
  secretLiterals: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const COMMAND_REJECT_PATTERN = /[\s;&|<>$`\\"'(){}[\]*?~#!]/u;
const MAX_MCP_CONFIG_BYTES = 256 * 1024;
const MAX_MCP_SERVERS = 16;
const MAX_SKILLS = 24;

function launchProfiles(agentType: AgentType): ProviderLaunchProfileDescriptor[] {
  if (agentType !== "codex" && agentType !== "claudeCode") {
    return [
      { id: "work", intent: "work", isDefault: true, requiresStartConfirmation: true },
    ];
  }
  return [
    { id: "work", intent: "work", isDefault: true, requiresStartConfirmation: true },
    { id: "plan", intent: "plan", isDefault: false, requiresStartConfirmation: false },
    { id: "review", intent: "review", isDefault: false, requiresStartConfirmation: false },
  ];
}

function defaultModel(): ProviderModelOptionDescriptor {
  return { id: "default", displayName: "Default", isDefault: true };
}

function claudeModels(): ProviderModelOptionDescriptor[] {
  return [
    defaultModel(),
    { id: "sonnet", displayName: "Sonnet", isDefault: false },
    { id: "opus", displayName: "Opus", isDefault: false },
    { id: "fable", displayName: "Fable", isDefault: false },
  ];
}

function codexModels(cachePath: string): ProviderModelOptionDescriptor[] {
  const models: ProviderModelOptionDescriptor[] = [defaultModel()];
  try {
    const decoded = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };
    for (const candidate of decoded.models ?? []) {
      if (
        candidate.visibility !== "list" ||
        typeof candidate.slug !== "string" ||
        !SAFE_ID.test(candidate.slug) ||
        typeof candidate.display_name !== "string" ||
        candidate.display_name.length === 0 ||
        candidate.display_name.length > 48 ||
        /[\\/\r\n]/u.test(candidate.display_name) ||
        models.some((model) => model.id === candidate.slug)
      ) {
        continue;
      }
      models.push({
        id: candidate.slug,
        displayName: candidate.display_name,
        isDefault: false,
      });
      if (models.length >= 7) break;
    }
  } catch {
    // A missing/stale model cache is normal; the CLI's own default remains usable.
  }
  return models;
}

function permissionProfiles(agentType: AgentType): ProviderPermissionProfileDescriptor[] {
  if (agentType !== "codex" && agentType !== "claudeCode") {
    return [
      {
        id: "host-default",
        mode: "host_default",
        enforcement: "host_policy",
        isDefault: true,
        requiresStartConfirmation: true,
        riskLevel: "medium",
        warnings: ["provider_managed_controls"],
      },
    ];
  }

  return [
    {
      id: "observe",
      mode: "observe",
      enforcement: "provider_policy",
      isDefault: false,
      requiresStartConfirmation: false,
      riskLevel: "low",
      warnings: ["agent_level_read_only"],
    },
    {
      id: "supervised",
      mode: "supervised",
      enforcement: agentType === "claudeCode" ? "approval_bridge" : "provider_policy",
      isDefault: true,
      requiresStartConfirmation: true,
      riskLevel: "high",
      warnings:
        agentType === "claudeCode"
          ? ["phone_approval_available"]
          : ["provider_managed_approval"],
    },
  ];
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function discoverSkills(workingDirectory: string | undefined, agentType: AgentType): string[] {
  if (!workingDirectory || (agentType !== "codex" && agentType !== "claudeCode")) return [];
  const roots =
    agentType === "claudeCode"
      ? [join(workingDirectory, ".claude", "skills")]
      : [join(workingDirectory, ".agents", "skills")];
  const names = new Set<string>();

  for (const configuredRoot of roots) {
    let root: string;
    try {
      if (lstatSync(configuredRoot).isSymbolicLink()) continue;
      root = realpathSync(configuredRoot);
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (names.size >= MAX_SKILLS) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name)) continue;
      const skillDir = resolve(root, entry.name);
      const manifest = join(skillDir, "SKILL.md");
      try {
        if (!isInside(root, realpathSync(skillDir))) continue;
        const manifestStat = lstatSync(manifest);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 64 * 1024) {
          continue;
        }
        if (!isInside(root, realpathSync(manifest))) continue;
        names.add(entry.name);
      } catch {
        // A partially-created or removed Skill is simply not advertised.
      }
    }
  }
  return [...names].sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface LoadedClaudeMcp {
  servers: Record<string, ClaudeMcpServerRuntimeConfig>;
  secretLiterals: string[];
  digest: string;
}

function loadClaudeProjectMcp(workingDirectory: string | undefined): LoadedClaudeMcp {
  const empty: LoadedClaudeMcp = {
    servers: {},
    secretLiterals: [],
    digest: "none",
  };
  if (!workingDirectory) return empty;
  const configPath = join(workingDirectory, ".mcp.json");
  let rawText: string;
  try {
    const file = lstatSync(configPath);
    if (file.isSymbolicLink() || !file.isFile() || file.size > MAX_MCP_CONFIG_BYTES) return empty;
    const realConfig = realpathSync(configPath);
    const realWorkspace = realpathSync(workingDirectory);
    if (!isInside(realWorkspace, realConfig)) return empty;
    rawText = readFileSync(realConfig, "utf8");
  } catch {
    return empty;
  }

  let decoded: Record<string, unknown> | undefined;
  try {
    decoded = asRecord(JSON.parse(rawText));
  } catch {
    return empty;
  }
  const rawServers = asRecord(decoded?.["mcpServers"]);
  if (!rawServers) return empty;

  const servers: Record<string, ClaudeMcpServerRuntimeConfig> = {};
  const secrets = new Set<string>();
  for (const [name, rawServer] of Object.entries(rawServers)) {
    if (Object.keys(servers).length >= MAX_MCP_SERVERS) break;
    if (!SAFE_ID.test(name) || name === "orbitory") continue;
    const server = asRecord(rawServer);
    if (!server) continue;
    const allowedKeys = new Set(["type", "command", "args", "env"]);
    if (Object.keys(server).some((key) => !allowedKeys.has(key))) continue;
    if (server["type"] !== undefined && server["type"] !== "stdio") continue;
    const command = server["command"];
    if (
      typeof command !== "string" ||
      command.length === 0 ||
      command.length > 512 ||
      COMMAND_REJECT_PATTERN.test(command)
    ) {
      continue;
    }
    const rawArgs = server["args"];
    if (
      rawArgs !== undefined &&
      (!Array.isArray(rawArgs) ||
        rawArgs.length > 32 ||
        !rawArgs.every(
          (arg) => typeof arg === "string" && arg.length <= 1024 && !arg.includes("\0"),
        ))
    ) {
      continue;
    }
    const rawEnv = server["env"];
    let env: Record<string, string> | undefined;
    if (rawEnv !== undefined) {
      const envRecord = asRecord(rawEnv);
      if (!envRecord || Object.keys(envRecord).length > 32) continue;
      env = {};
      let valid = true;
      for (const [key, value] of Object.entries(envRecord)) {
        if (
          !ENV_NAME.test(key) ||
          key.startsWith("ORBITORY_") ||
          typeof value !== "string" ||
          value.length > 4096 ||
          value.includes("\0")
        ) {
          valid = false;
          break;
        }
        env[key] = value;
        if (value.length >= 8) secrets.add(value);
      }
      if (!valid) continue;
    }
    servers[name] = {
      command,
      args: Array.isArray(rawArgs) ? [...rawArgs] : [],
      ...(env ? { env } : {}),
    };
  }

  return {
    servers,
    secretLiterals: [...secrets],
    digest: createHash("sha256").update(rawText).digest("hex"),
  };
}

function toolsets(
  agentType: AgentType,
  workingDirectory: string | undefined,
): { descriptors: ProviderToolsetDescriptor[]; runtime: Map<string, RuntimeToolset>; digest: string } {
  const skills = discoverSkills(workingDirectory, agentType);
  const claudeMcp = agentType === "claudeCode" ? loadClaudeProjectMcp(workingDirectory) : {
    servers: {},
    secretLiterals: [],
    digest: "not-applicable",
  };
  const runtime = new Map<string, RuntimeToolset>();
  const none: ProviderToolsetDescriptor = {
    id: "none",
    includesMcp: false,
    includesSkills: false,
    mcpServerCount: 0,
    skillCount: 0,
    isDefault: true,
    requiresStartConfirmation: false,
    riskLevel: "low",
    warnings: [],
  };
  runtime.set("none", {
    descriptor: none,
    skillNames: [],
    claudeMcpServers: {},
    secretLiterals: [],
  });

  if (agentType === "codex" || agentType === "claudeCode") {
    const descriptor: ProviderToolsetDescriptor = {
      id: "project-skills",
      includesMcp: false,
      includesSkills: true,
      mcpServerCount: 0,
      skillCount: skills.length,
      isDefault: false,
      requiresStartConfirmation: false,
      riskLevel: "medium",
      warnings: ["skills_are_instructions", "project_contents_checked_at_launch"],
    };
    runtime.set(descriptor.id, {
      descriptor,
      skillNames: skills,
      claudeMcpServers: {},
      secretLiterals: [],
    });
  }

  const mcpServers = claudeMcp.servers;
  if (agentType === "claudeCode") {
    const descriptor: ProviderToolsetDescriptor = {
      id: "project-tools",
      includesMcp: true,
      includesSkills: skills.length > 0,
      mcpServerCount: Object.keys(mcpServers).length,
      skillCount: skills.length,
      isDefault: false,
      requiresStartConfirmation: true,
      riskLevel: "high",
      warnings: [
        "mcp_tools_require_approval",
        "mcp_content_untrusted",
        "project_contents_checked_at_launch",
      ],
    };
    runtime.set(descriptor.id, {
      descriptor,
      skillNames: skills,
      claudeMcpServers: mcpServers,
      secretLiterals: claudeMcp.secretLiterals,
    });
  }

  const descriptors = [...runtime.values()].map((entry) => entry.descriptor);
  const digest = createHash("sha256")
    .update(JSON.stringify({ skills, mcp: claudeMcp.digest, descriptors }))
    .digest("hex");
  return { descriptors, runtime, digest };
}

export function loadProviderControls(
  agentType: AgentType,
  opts: { codexModelCachePath?: string; workingDirectory?: string } = {},
): ProviderControls {
  const models =
    agentType === "codex"
      ? codexModels(opts.codexModelCachePath ?? join(homedir(), ".codex", "models_cache.json"))
      : agentType === "claudeCode"
        ? claudeModels()
        : [defaultModel()];
  const launch = launchProfiles(agentType);
  const permissions = permissionProfiles(agentType);
  const availableToolsets = toolsets(agentType, opts.workingDirectory);
  const catalogDigest = createHash("sha256")
    .update(
      JSON.stringify({
        launch,
        models,
        permissions,
        toolsets: availableToolsets.descriptors,
        privateToolsetDigest: availableToolsets.digest,
      }),
    )
    .digest("hex");
  return {
    launchProfiles: launch,
    models,
    permissionProfiles: permissions,
    toolsets: availableToolsets.descriptors,
    catalogDigest,
    runtimeToolsets: availableToolsets.runtime,
  };
}

export function resolveProviderSelection(
  controls: ProviderControls,
  launchProfileId?: string,
  modelId?: string,
  permissionProfileId?: string,
  toolsetId?: string,
): ResolvedProviderSelection | undefined {
  const launch = launchProfileId
    ? controls.launchProfiles.find((candidate) => candidate.id === launchProfileId)
    : controls.launchProfiles.find((candidate) => candidate.isDefault);
  const model = modelId
    ? controls.models.find((candidate) => candidate.id === modelId)
    : controls.models.find((candidate) => candidate.isDefault);
  const permission = permissionProfileId
    ? controls.permissionProfiles.find((candidate) => candidate.id === permissionProfileId)
    : controls.permissionProfiles.find((candidate) => candidate.isDefault);
  const runtimeToolset = toolsetId
    ? controls.runtimeToolsets.get(toolsetId)
    : [...controls.runtimeToolsets.values()].find((candidate) => candidate.descriptor.isDefault);
  if (!launch || !model || !permission || !runtimeToolset) return undefined;
  return {
    launchProfileId: launch.id,
    intent: launch.intent,
    modelId: model.id,
    ...(model.id === "default" ? {} : { modelCliValue: model.id }),
    permissionProfileId: permission.id,
    permissionMode: permission.mode,
    toolsetId: runtimeToolset.descriptor.id,
    includesMcp: runtimeToolset.descriptor.includesMcp,
    includesSkills: runtimeToolset.descriptor.includesSkills,
    skillNames: [...runtimeToolset.skillNames],
    claudeMcpServers: { ...runtimeToolset.claudeMcpServers },
    secretLiterals: [...runtimeToolset.secretLiterals],
  };
}
