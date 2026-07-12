import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AgentType,
  ProviderLaunchIntent,
  ProviderLaunchProfileDescriptor,
  ProviderModelOptionDescriptor,
} from "./types.js";

export interface ProviderControls {
  launchProfiles: ProviderLaunchProfileDescriptor[];
  models: ProviderModelOptionDescriptor[];
}

export interface ResolvedProviderSelection {
  launchProfileId: string;
  intent: ProviderLaunchIntent;
  modelId: string;
  modelCliValue?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

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

export function loadProviderControls(
  agentType: AgentType,
  opts: { codexModelCachePath?: string } = {},
): ProviderControls {
  const models =
    agentType === "codex"
      ? codexModels(opts.codexModelCachePath ?? join(homedir(), ".codex", "models_cache.json"))
      : agentType === "claudeCode"
        ? claudeModels()
        : [defaultModel()];
  return { launchProfiles: launchProfiles(agentType), models };
}

export function resolveProviderSelection(
  controls: ProviderControls,
  launchProfileId?: string,
  modelId?: string,
): ResolvedProviderSelection | undefined {
  const launch = launchProfileId
    ? controls.launchProfiles.find((candidate) => candidate.id === launchProfileId)
    : controls.launchProfiles.find((candidate) => candidate.isDefault);
  const model = modelId
    ? controls.models.find((candidate) => candidate.id === modelId)
    : controls.models.find((candidate) => candidate.isDefault);
  if (!launch || !model) return undefined;
  return {
    launchProfileId: launch.id,
    intent: launch.intent,
    modelId: model.id,
    ...(model.id === "default" ? {} : { modelCliValue: model.id }),
  };
}
