#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = resolve(root, "dist/index.js");
const extra = process.argv.slice(2);
const setupProviderAliases = new Map([
  ["codex", "codex"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["demo", "demo"],
]);
const supportedOptions = new Set([
  "--help",
  "-h",
  "--demo",
  "--tailscale",
  "--relay",
  "--init-config",
  "--setup",
  "--yes",
  "-y",
  "--login-device",
  "--login-browser",
  "--include-codex-projects",
  "--include-recent-projects",
  "--allow-project-creation",
  "--project-root",
  "--list-providers",
  "--remove-provider",
]);
const wantsHelp = extra.includes("--help") || extra.includes("-h");
const wantsDemo = extra.includes("--demo");
const wantsTailscale = extra.includes("--tailscale");
const wantsRelay = extra.includes("--relay");
const wantsInitConfig = extra.includes("--init-config");
const wantsSetup = extra.includes("--setup");
const wantsYes = extra.includes("--yes") || extra.includes("-y");
const wantsLoginDevice = extra.includes("--login-device");
const wantsLoginBrowser = extra.includes("--login-browser");
const wantsIncludeCodexProjects = extra.includes("--include-codex-projects");
const wantsIncludeRecentProjects = extra.includes("--include-recent-projects");
const wantsAllowProjectCreation = extra.includes("--allow-project-creation");
const projectRootIndex = extra.indexOf("--project-root");
const wantsProjectRoot = projectRootIndex >= 0;
const requestedProjectRoot = wantsProjectRoot ? extra[projectRootIndex + 1] : undefined;
const wantsListProviders = extra.includes("--list-providers");
const removeProviderIndex = extra.indexOf("--remove-provider");
const wantsRemoveProvider = removeProviderIndex >= 0;
const removeProviderId = wantsRemoveProvider ? extra[removeProviderIndex + 1] : undefined;
const setupProviderArg = extra.find((option) => setupProviderAliases.has(option));
const unknownOption = extra.find((option) => option.startsWith("-") && !supportedOptions.has(option));
const unknownPositional = extra.find((option, index) =>
  !option.startsWith("-") &&
  !(wantsSetup && setupProviderAliases.has(option)) &&
  !(wantsRemoveProvider && index === removeProviderIndex + 1) &&
  !(wantsProjectRoot && index === projectRootIndex + 1)
);

if (wantsHelp) {
  console.log(
    [
      "Usage: orbitory-host [--demo] [--tailscale] [--relay] [--setup [codex|claude|demo] [--yes]] [--init-config]",
      "",
      "Starts the local Orbitory host-agent and prints a sensitive pairing QR/code.",
      "By default, the TestFlight app sees only this computer and real configured sessions.",
      "",
      "Options:",
      "  --demo         Seed fake demo hosts/sessions for screenshots or guided exploration.",
      "  --tailscale    Advertise the private Tailscale IPv4 for remote tailnet access.",
      "                 Overrides ORBITORY_ADVERTISED_HOST for this launch.",
      "  --relay        Run the security-gated Orbitory Relay preflight.",
      "                 This release does not start a public Relay or open a Relay socket.",
      "  --setup        Guided setup for an enabled local AI provider in ./orbitory.config.json.",
      "  --yes, -y      Use defaults with --setup; useful for scripts and quick local setup.",
      "  --login-device Sign in on another device during setup (Codex device code; Claude return code).",
      "  --login-browser Sign in through the provider's official browser flow during setup.",
      "  --include-codex-projects  Let Orbitory list/resume recent Codex projects (experimental, broad access).",
      "  --include-recent-projects Let this Claude provider run in those discovered project folders.",
      "  --allow-project-creation  Let Orbitory create empty projects under one host-approved folder.",
      "  --project-root <folder>   Parent folder used with --allow-project-creation (default: project parent).",
      "  --list-providers          List provider ids configured in this folder, then exit.",
      "  --remove-provider <id>    Remove one provider from this folder after local confirmation.",
      "  --init-config  Create ./orbitory.config.json with a safe starter provider, then exit.",
      "",
      "Examples:",
      "  npx orbitory-host@latest --setup",
      "  npx orbitory-host@latest --setup codex --yes",
      "  npx orbitory-host@latest --setup codex --login-device --yes",
      "  npx orbitory-host@latest --setup codex --include-codex-projects --yes",
      "  npx orbitory-host@latest --setup claude --include-recent-projects --yes",
      "  npx orbitory-host@latest --setup codex --allow-project-creation --project-root .. --yes",
      "  npx orbitory-host@latest --list-providers",
      "  npx orbitory-host@latest --remove-provider codex-local",
      "  npx orbitory-host@latest --tailscale",
      "  npx orbitory-host@latest --relay  # security preflight; expected to fail closed",
      "  npx orbitory-host@latest",
      "",
      "Common environment variables:",
      "  PORT=4000",
      "  ORBITORY_ADVERTISED_HOST=192.168.1.10",
      "  ORBITORY_PAIRING_TOKEN=<random-secret>",
      "  ORBITORY_TLS_ENABLED=true",
      "  ORBITORY_TLS_CERT_PATH=/path/to/cert.pem",
      "  ORBITORY_TLS_KEY_PATH=/path/to/key.pem",
    ].join("\n"),
  );
  process.exit(0);
}

if (unknownOption || unknownPositional) {
  console.error(`[orbitory-host] Unknown option: ${unknownOption ?? unknownPositional}`);
  console.error("Run `orbitory-host --help` for supported configuration.");
  process.exit(1);
}

if (wantsRemoveProvider && (!removeProviderId || removeProviderId.startsWith("-"))) {
  console.error("[orbitory-host] --remove-provider requires the exact provider id. Use --list-providers first.");
  process.exit(1);
}

if (wantsProjectRoot && (!requestedProjectRoot || requestedProjectRoot.startsWith("-"))) {
  console.error("[orbitory-host] --project-root requires a folder path.");
  process.exit(1);
}

const managementModeCount = [wantsSetup, wantsInitConfig, wantsListProviders, wantsRemoveProvider]
  .filter(Boolean).length;
if (managementModeCount > 1) {
  console.error("[orbitory-host] Choose only one of --setup, --init-config, --list-providers, or --remove-provider.");
  process.exit(1);
}

if (wantsInitConfig && wantsSetup) {
  console.error("[orbitory-host] Choose either --setup or --init-config, not both.");
  process.exit(1);
}

if ((wantsLoginDevice || wantsLoginBrowser) && !wantsSetup) {
  console.error("[orbitory-host] --login-device/--login-browser can only be used with --setup.");
  process.exit(1);
}

if ((wantsIncludeCodexProjects || wantsIncludeRecentProjects) && !wantsSetup) {
  console.error("[orbitory-host] Project sharing flags can only be used with --setup.");
  process.exit(1);
}

if ((wantsAllowProjectCreation || wantsProjectRoot) && !wantsSetup) {
  console.error("[orbitory-host] Project creation flags can only be used with --setup.");
  process.exit(1);
}

if (wantsProjectRoot && !wantsAllowProjectCreation) {
  console.error("[orbitory-host] --project-root requires --allow-project-creation.");
  process.exit(1);
}

if (wantsLoginDevice && wantsLoginBrowser) {
  console.error("[orbitory-host] Choose either --login-device or --login-browser, not both.");
  process.exit(1);
}

if (wantsRelay && wantsTailscale) {
  console.error("[orbitory-host] Choose either --relay or --tailscale, not both.");
  process.exit(1);
}

if (wantsRelay && (wantsDemo || managementModeCount > 0)) {
  console.error("[orbitory-host] --relay cannot be combined with demo or provider-management options.");
  process.exit(1);
}

if (wantsSetup) {
  await runGuidedSetup({
    requestedProvider: setupProviderArg ? setupProviderAliases.get(setupProviderArg) : undefined,
    assumeYes: wantsYes,
    loginDevice: wantsLoginDevice,
    loginBrowser: wantsLoginBrowser,
    includeCodexProjects: wantsIncludeCodexProjects,
    includeRecentProjects: wantsIncludeRecentProjects,
    allowProjectCreation: wantsAllowProjectCreation,
    projectRoot: requestedProjectRoot,
  });
  process.exit(0);
}

if (wantsListProviders) {
  listConfiguredProviders(resolve(process.cwd(), "orbitory.config.json"));
  process.exit(0);
}

if (wantsRemoveProvider) {
  await removeConfiguredProvider(resolve(process.cwd(), "orbitory.config.json"), removeProviderId, wantsYes);
  process.exit(0);
}

if (wantsInitConfig) {
  const configPath = resolve(process.cwd(), "orbitory.config.json");
  if (existsSync(configPath)) {
    console.error(`[orbitory-host] ${configPath} already exists; leaving it unchanged.`);
    process.exit(1);
  }

  const currentDirectory = process.cwd();
  const config = {
    agents: [
      createDemoProviderConfig(currentDirectory),
      { ...createClaudeProviderConfig(currentDirectory), enabled: false },
      { ...createCodexProviderConfig(currentDirectory), enabled: false },
    ],
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`[orbitory-host] Created ${configPath}`);
  console.log("[orbitory-host] Restart with `npx orbitory-host@latest`, then tap Refresh in Orbitory.");
  console.log("[orbitory-host] To use Claude Code or Codex, review the file and set that provider's enabled field to true.");
  process.exit(0);
}

if (!existsSync(entrypoint)) {
  console.error(
    [
      "[orbitory-host] Built files are missing.",
      "Run `npm run build` in the package source, or reinstall the published package.",
    ].join("\n"),
  );
  process.exit(1);
}

if (wantsRelay) {
  await enforceRelaySecurityGate();
}

if (wantsTailscale) {
  const tailscaleHost = detectPrivateTailscaleIPv4();
  process.env.ORBITORY_ADVERTISED_HOST = tailscaleHost;
  console.log(`[orbitory-host] Using private Tailscale address ${tailscaleHost}.`);
}

process.env.ORBITORY_PRINT_PAIRING_CODE ??= "true";
process.env.ORBITORY_DEMO_SESSIONS ??= wantsDemo ? "true" : "false";

await import(pathToFileURL(entrypoint).href);

async function enforceRelaySecurityGate() {
  const gatePath = resolve(root, "dist/relayPolicy.js");
  if (!existsSync(gatePath)) {
    console.error("[orbitory-host] Relay security gate is missing; no host was started.");
    process.exit(1);
  }

  let evaluateRelayLaunchGate;
  let relayReleaseEvidence;
  let compiledCryptographicProviderId;
  try {
    ({
      evaluateRelayLaunchGate,
      RELAY_RELEASE_EVIDENCE: relayReleaseEvidence,
      RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID: compiledCryptographicProviderId,
    } = await import(pathToFileURL(gatePath).href));
  } catch {
    console.error("[orbitory-host] Relay security gate could not be loaded; no host was started.");
    process.exit(1);
  }

  if (typeof evaluateRelayLaunchGate !== "function") {
    console.error("[orbitory-host] Relay security gate is invalid; no host was started.");
    process.exit(1);
  }
  if (
    !relayReleaseEvidence ||
    relayReleaseEvidence.schemaVersion !== 1 ||
    (relayReleaseEvidence.status !== "go" && relayReleaseEvidence.status !== "no-go")
  ) {
    console.error("[orbitory-host] Relay release evidence is missing or invalid; no host was started.");
    process.exit(1);
  }

  const pairingToken = process.env.ORBITORY_PAIRING_TOKEN;
  const decision = evaluateRelayLaunchGate({
    relayUrl: process.env.ORBITORY_RELAY_URL,
    cryptographicProviderId: compiledCryptographicProviderId,
    releaseDecisionApproved: relayReleaseEvidence.status === "go",
    pairingTokenConfigured: typeof pairingToken === "string" && pairingToken.trim() !== "",
    staticPairingTokenDisabled: process.env.ORBITORY_DISABLE_STATIC_TOKEN === "true",
    threatModelReviewed: relayReleaseEvidence.threatModelReviewed === true,
    cryptographicReviewCompleted: relayReleaseEvidence.cryptographicReviewCompleted === true,
    replayAndOrderingReviewCompleted: relayReleaseEvidence.replayAndOrderingReviewCompleted === true,
    privacyReviewCompleted: relayReleaseEvidence.privacyReviewCompleted === true,
    exportComplianceReviewed: relayReleaseEvidence.exportComplianceReviewed === true,
    killSwitchEnabled: process.env.ORBITORY_RELAY_KILL_SWITCH_ENABLED === "true",
    keyStorageReviewed: relayReleaseEvidence.keyStorageReviewed === true,
    interoperabilityReviewCompleted: relayReleaseEvidence.interoperabilityReviewCompleted === true,
    revocationReviewCompleted: relayReleaseEvidence.revocationReviewCompleted === true,
    physical4GReviewCompleted: relayReleaseEvidence.physical4GReviewCompleted === true,
    soak24HourReviewCompleted: relayReleaseEvidence.soak24HourReviewCompleted === true,
  });

  if (!decision.allowed) {
    console.error("[orbitory-host] Relay security gate blocked startup.");
    console.error(`[orbitory-host] Blocking checks: ${decision.blockCodes.join(", ")}`);
    console.error("[orbitory-host] No Relay or host socket was opened; no host was started.");
    process.exit(1);
  }

  // The gate becoming ready is necessary but not sufficient. A reviewed
  // transport implementation must replace this unconditional stop.
  console.error("[orbitory-host] Relay transport is not bundled in this release; no host was started.");
  process.exit(1);
}

function detectPrivateTailscaleIPv4() {
  const result = spawnSync("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 4_096,
  });
  if (result.error?.code === "ENOENT") {
    console.error("[orbitory-host] Tailscale CLI was not found on PATH; no host was started.");
    process.exit(1);
  }
  if (result.error || result.status !== 0) {
    console.error(
      "[orbitory-host] Could not detect a private Tailscale IPv4. Make sure Tailscale is running and logged in; no host was started.",
    );
    process.exit(1);
  }

  const address = parsePrivateTailscaleIPv4(result.stdout);
  if (!address) {
    console.error(
      "[orbitory-host] Tailscale returned an invalid address. Expected exactly one IPv4 in 100.64.0.0/10; no host was started.",
    );
    process.exit(1);
  }
  return address;
}

function parsePrivateTailscaleIPv4(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return undefined;
  const address = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  if (address.includes("\r") || address.includes("\n") || address !== address.trim()) {
    return undefined;
  }
  if (!isIPv4(address)) return undefined;

  const [firstOctet, secondOctet] = address.split(".").map(Number);
  if (firstOctet !== 100 || secondOctet < 64 || secondOctet > 127) {
    return undefined;
  }
  return address;
}

async function runGuidedSetup({
  requestedProvider,
  assumeYes,
  loginDevice,
  loginBrowser,
  includeCodexProjects,
  includeRecentProjects,
  allowProjectCreation,
  projectRoot,
}) {
  const detected = detectInstalledProviders();
  const rl = shouldAskQuestions(requestedProvider, assumeYes)
    ? createInterface({ input, output })
    : undefined;

  try {
    const provider = requestedProvider ?? (assumeYes ? chooseDefaultProvider(detected) : await askForProvider(rl, detected));
    if (!provider) {
      console.error("[orbitory-host] Setup cancelled.");
      return;
    }
    if (includeCodexProjects && provider !== "codex") {
      console.error("[orbitory-host] --include-codex-projects requires --setup codex.");
      process.exit(1);
    }
    if (includeRecentProjects && provider !== "claude") {
      console.error("[orbitory-host] --include-recent-projects requires --setup claude.");
      process.exit(1);
    }
    if ((allowProjectCreation || projectRoot) && provider === "demo") {
      console.error("[orbitory-host] Project creation requires --setup codex or --setup claude.");
      process.exit(1);
    }

    const workingDirectory = assumeYes
      ? process.cwd()
      : await askForWorkingDirectory(rl, process.cwd());
    if (!isDirectory(workingDirectory)) {
      console.error(`[orbitory-host] Project folder not found: ${workingDirectory}`);
      process.exit(1);
    }

    const configPath = resolve(workingDirectory, "orbitory.config.json");
    const config = loadConfigForSetup(configPath);
    const existingProvider = findExistingProvider(config.agents, provider, workingDirectory);
    // A host-authoritative existing config pins the CLI that real sessions
    // already use. Prefer it over PATH so duplicate/older installations do
    // not produce a false login failure or silently replace the working CLI.
    const providerCommand = provider === "demo"
      ? undefined
      : existingProvider?.command ?? detected[provider];

    if (provider !== "demo" && !providerCommand) {
      const displayName = providerDisplayName(provider);
      const installUrl = provider === "codex"
        ? "https://developers.openai.com/codex/cli"
        : "https://code.claude.com/docs/en/setup";
      console.error(`[orbitory-host] ${displayName} CLI was not found. Install it from ${installUrl}, then rerun setup.`);
      console.error("[orbitory-host] No provider configuration was changed.");
      process.exit(1);
    }

    if (provider !== "demo" && providerCommand) {
      let loginReady = providerLoginReady(provider, providerCommand);
      const requestedLoginMode = loginReady
        ? undefined
        : loginDevice
          ? "phone"
          : loginBrowser
            ? "browser"
            : !assumeYes && rl
              ? await askForLoginMode(rl, provider)
              : undefined;
      if (!loginReady && requestedLoginMode && requestedLoginMode !== "later") {
        const displayName = providerDisplayName(provider);
        const command = providerCommand;
        const useCodexDeviceFlow = provider === "codex" && requestedLoginMode === "phone";
        const args = provider === "codex"
          ? useCodexDeviceFlow ? ["login", "--device-auth"] : ["login"]
          : ["auth", "login"];
        const flowName = requestedLoginMode === "phone" ? "device" : "browser";
        const instruction = requestedLoginMode === "phone"
          ? "Open the displayed URL on your phone and enter or return the code."
          : "Complete the provider's official sign-in page.";
        console.log(`[orbitory-host] Starting ${displayName} ${flowName} login. ${instruction}`);
        rl?.pause();
        const login = spawnSync(command, args, { stdio: "inherit" });
        rl?.resume();
        loginReady = login.status === 0 && providerLoginReady(provider, providerCommand);
        if (!loginReady) {
          console.error(`[orbitory-host] ${displayName} login did not complete. No provider configuration was changed.`);
          process.exit(1);
        }
      }
      if (!loginReady && requestedLoginMode === "later") {
        console.error(`[orbitory-host] ${providerDisplayName(provider)} is not logged in. No provider configuration was changed.`);
        process.exit(1);
      }
      if (!loginReady && requestedLoginMode === undefined) {
        const commands = provider === "codex"
          ? "Run `codex login` on this Mac, or `codex login --device-auth` to approve on your phone."
          : "Run `claude auth login` and complete Claude Code's official sign-in flow.";
        console.error(`[orbitory-host] ${providerDisplayName(provider)} is not logged in. ${commands}`);
        console.error("[orbitory-host] No provider configuration was changed.");
        process.exit(1);
      }
      if (loginReady) {
        console.log(`[orbitory-host] ${providerDisplayName(provider)} login: ready.`);
      }
    }

    const providerConfig = createProviderConfig(
      provider,
      workingDirectory,
      providerCommand,
      existingProvider?.id ?? createProviderId(provider),
    );
    const enableCodexHistory = provider === "codex" && (
      includeCodexProjects ||
      (!assumeYes && await askForCodexHistory(rl))
    );
    const codexHistory =
      config.projectCatalog && typeof config.projectCatalog === "object" &&
      config.projectCatalog.codexHistory && typeof config.projectCatalog.codexHistory === "object"
        ? config.projectCatalog.codexHistory
        : undefined;
    const enableRecentProjects = provider === "claude" && Boolean(codexHistory?.enabled) && (
      includeRecentProjects ||
      (!assumeYes && await askForRecentProjects(rl))
    );
    if (provider === "claude" && includeRecentProjects && !codexHistory?.enabled) {
      console.error("[orbitory-host] Enable recent Codex projects first with `--setup codex --include-codex-projects`.");
      console.error("[orbitory-host] No provider configuration was changed.");
      process.exit(1);
    }
    const nextConfig = {
      ...config,
      agents: upsertAgent(config.agents, providerConfig),
    };
    if (provider === "codex") {
      const nextProjectCatalog = config.projectCatalog && typeof config.projectCatalog === "object"
        ? { ...config.projectCatalog }
        : {};
      if (enableCodexHistory) {
        nextProjectCatalog.codexHistory = {
          enabled: true,
          providerId: providerConfig.id,
          maxSessions: 100,
        };
      } else {
        delete nextProjectCatalog.codexHistory;
      }
      if (Object.keys(nextProjectCatalog).length > 0) {
        nextConfig.projectCatalog = nextProjectCatalog;
      } else {
        delete nextConfig.projectCatalog;
      }
    }
    if (provider === "claude" && codexHistory) {
      const nextProjectCatalog = config.projectCatalog && typeof config.projectCatalog === "object"
        ? { ...config.projectCatalog }
        : {};
      const nextCodexHistory = { ...codexHistory };
      const existing = Array.isArray(nextCodexHistory.additionalProviderIds)
        ? nextCodexHistory.additionalProviderIds.filter((id) => typeof id === "string")
        : [];
      const additionalProviderIds = enableRecentProjects
        ? Array.from(new Set([...existing, providerConfig.id]))
        : existing.filter((id) => id !== providerConfig.id);
      if (additionalProviderIds.length > 0) {
        nextCodexHistory.additionalProviderIds = additionalProviderIds;
      } else {
        delete nextCodexHistory.additionalProviderIds;
      }
      nextProjectCatalog.codexHistory = nextCodexHistory;
      nextConfig.projectCatalog = nextProjectCatalog;
    }

    if (provider !== "demo") {
      const existingCreation =
        config.projectCatalog && typeof config.projectCatalog === "object" &&
        config.projectCatalog.creation && typeof config.projectCatalog.creation === "object"
          ? config.projectCatalog.creation
          : undefined;
      const wasEnabledForProvider = Boolean(
        existingCreation?.enabled === true &&
        Array.isArray(existingCreation.providerIds) &&
        existingCreation.providerIds.includes(providerConfig.id),
      );
      const enableProjectCreation = allowProjectCreation || (
        !assumeYes && await askForProjectCreation(rl, wasEnabledForProvider)
      );
      const nextProjectCatalog = nextConfig.projectCatalog && typeof nextConfig.projectCatalog === "object"
        ? { ...nextConfig.projectCatalog }
        : {};

      if (enableProjectCreation) {
        const configuredRoot = typeof existingCreation?.rootDirectory === "string"
          ? resolve(workingDirectory, existingCreation.rootDirectory)
          : dirname(workingDirectory);
        const selectedRoot = projectRoot
          ? resolve(workingDirectory, projectRoot)
          : !assumeYes
            ? await askForProjectCreationRoot(rl, configuredRoot)
            : configuredRoot;
        if (!isDirectory(selectedRoot)) {
          console.error(`[orbitory-host] New-project parent folder not found: ${selectedRoot}`);
          console.error("[orbitory-host] No provider configuration was changed.");
          process.exit(1);
        }
        const existingProviderIds = Array.isArray(existingCreation?.providerIds)
          ? existingCreation.providerIds.filter((id) => typeof id === "string")
          : [];
        nextProjectCatalog.creation = {
          enabled: true,
          rootDirectory: realpathSync(selectedRoot),
          providerIds: Array.from(new Set([...existingProviderIds, providerConfig.id])),
          maxProjects: Number.isInteger(existingCreation?.maxProjects)
            ? existingCreation.maxProjects
            : 100,
        };
      } else if (!assumeYes && existingCreation) {
        const remainingProviderIds = Array.isArray(existingCreation.providerIds)
          ? existingCreation.providerIds.filter((id) => id !== providerConfig.id)
          : [];
        if (remainingProviderIds.length > 0) {
          nextProjectCatalog.creation = {
            ...existingCreation,
            providerIds: remainingProviderIds,
          };
        } else {
          delete nextProjectCatalog.creation;
        }
      }

      if (Object.keys(nextProjectCatalog).length > 0) {
        nextConfig.projectCatalog = nextProjectCatalog;
      } else {
        delete nextConfig.projectCatalog;
      }
    }

    writeConfigAtomically(configPath, nextConfig);

    console.log(`[orbitory-host] Updated ${configPath}`);
    console.log(`[orbitory-host] Enabled provider: ${providerConfig.displayName} (${providerConfig.id})`);
    if (enableCodexHistory) {
      console.log("[orbitory-host] Codex project history: enabled (experimental, broad project access). Disable projectCatalog.codexHistory to revoke it.");
    } else if (provider === "codex") {
      console.log("[orbitory-host] Codex project history: disabled.");
    }
    if (enableRecentProjects) {
      console.log("[orbitory-host] Claude access to recent projects: enabled (broad project access). Rerun setup without --include-recent-projects to revoke it.");
    } else if (provider === "claude" && codexHistory?.enabled) {
      console.log("[orbitory-host] Claude access to recent projects: disabled.");
    }
    const creation = nextConfig.projectCatalog?.creation;
    if (creation?.enabled === true && Array.isArray(creation.providerIds) && creation.providerIds.includes(providerConfig.id)) {
      console.log(`[orbitory-host] New project creation: enabled under ${creation.rootDirectory}.`);
      console.log("[orbitory-host] The iPhone receives only the capability, never this host path.");
    }
    console.log("[orbitory-host] If the Orbitory host is already running, tap Refresh in the app; the latest host reloads this setting automatically.");
    console.log("[orbitory-host] If no host is running, start it from this folder with `npx orbitory-host@latest`.");
  } finally {
    rl?.close();
  }
}

function shouldAskQuestions(requestedProvider, assumeYes) {
  return !assumeYes && Boolean(input.isTTY);
}

async function askForProvider(rl, detected) {
  if (!rl) {
    console.error("[orbitory-host] Non-interactive setup needs a provider, for example: --setup codex --yes");
    process.exit(1);
  }

  const defaultProvider = chooseDefaultProvider(detected);
  const availability = [
    detected.codex ? "Codex: found" : "Codex: not found",
    detected.claude ? "Claude Code: found" : "Claude Code: not found",
  ].join(", ");

  console.log(`[orbitory-host] AI provider setup (${availability})`);
  const answer = (await rl.question(`Choose provider [codex/claude/demo] (${defaultProvider}): `)).trim().toLowerCase();
  const chosen = answer === "" ? defaultProvider : setupProviderAliases.get(answer);
  if (!chosen) {
    console.error("[orbitory-host] Please choose codex, claude, or demo.");
    process.exit(1);
  }
  return chosen;
}

async function askForWorkingDirectory(rl, defaultDirectory) {
  if (!rl) {
    return defaultDirectory;
  }
  const answer = (await rl.question(`Project folder (${defaultDirectory}): `)).trim();
  return answer === "" ? defaultDirectory : resolve(defaultDirectory, answer);
}

async function askForLoginMode(rl, provider) {
  const displayName = providerDisplayName(provider);
  console.log(`[orbitory-host] ${displayName} is installed but not logged in.`);
  const answer = (await rl.question("Sign in [browser=This Mac / phone=another device / later] (browser): ")).trim().toLowerCase();
  const choice = answer === "" ? "browser" : answer;
  if (choice !== "browser" && choice !== "phone" && choice !== "later") {
    console.error("[orbitory-host] Please choose browser, phone, or later.");
    process.exit(1);
  }
  return choice;
}

async function askForCodexHistory(rl) {
  if (!rl) return false;
  console.log("[orbitory-host] Optional: Orbitory can show recent Codex projects and resume their sessions.");
  console.log("[orbitory-host] This grants the paired phone broad access to start Codex in those project folders.");
  const answer = (await rl.question("Enable recent Codex projects? [y/N]: ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function askForRecentProjects(rl) {
  if (!rl) return false;
  console.log("[orbitory-host] Optional: make this Claude provider available in the recent project folders already discovered by Orbitory.");
  console.log("[orbitory-host] This grants Claude broad access to start in those folders; Claude session history itself is not read.");
  const answer = (await rl.question("Enable Claude in recent projects? [y/N]: ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function askForProjectCreation(rl, currentlyEnabled) {
  if (!rl) return currentlyEnabled;
  console.log("[orbitory-host] Optional: Orbitory can create empty project folders from the paired iPhone.");
  console.log("[orbitory-host] Creation is limited to one parent folder selected on this Mac; the phone never receives its path.");
  const prompt = currentlyEnabled
    ? "Keep new project creation enabled for this provider? [Y/n]: "
    : "Allow new project creation for this provider? [y/N]: ";
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  if (answer === "") return currentlyEnabled;
  return answer === "y" || answer === "yes";
}

async function askForProjectCreationRoot(rl, defaultDirectory) {
  if (!rl) return defaultDirectory;
  const answer = (await rl.question(`New-project parent folder (${defaultDirectory}): `)).trim();
  return answer === "" ? defaultDirectory : resolve(defaultDirectory, answer);
}

function chooseDefaultProvider(detected) {
  if (detected.codex) {
    return "codex";
  }
  if (detected.claude) {
    return "claude";
  }
  return "demo";
}

function detectInstalledProviders() {
  return {
    codex: findCommand("codex"),
    claude: findCommand("claude"),
  };
}

function findCommand(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) {
    return undefined;
  }
  const first = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return first ? resolve(first) : undefined;
}

function providerLoginReady(provider, command) {
  const args = provider === "codex" ? ["login", "status"] : ["auth", "status"];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    env: providerRuntimeEnv(provider),
  });
  if (result.status !== 0) return false;
  return provider !== "claude" || claudeApiAuthenticationReady(command);
}

function claudeApiAuthenticationReady(command) {
  const probeDirectory = mkdtempSync(join(tmpdir(), "orbitory-claude-auth-"));
  try {
    const result = spawnSync(
      command,
      [
        "-p",
        "Reply with only OK.",
        "--output-format",
        "json",
        "--tools",
        "",
        "--permission-mode",
        "plan",
        "--no-session-persistence",
        "--safe-mode",
        "--disable-slash-commands",
      ],
      {
        cwd: probeDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 45_000,
        env: providerRuntimeEnv("claude"),
      },
    );
    return result.status === 0;
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

function providerRuntimeEnvAllowlist(provider) {
  return provider === "codex"
    ? ["PATH", "HOME", "OPENAI_API_KEY"]
    : ["PATH", "HOME", "USER", "LOGNAME"];
}

function providerRuntimeEnv(provider) {
  const env = {};
  for (const key of providerRuntimeEnvAllowlist(provider)) {
    if (process.env[key] !== undefined && key !== "ORBITORY_PAIRING_TOKEN") {
      env[key] = process.env[key];
    }
  }
  return env;
}

function providerDisplayName(provider) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function loadConfigForSetup(configPath) {
  if (!existsSync(configPath)) {
    return { agents: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    console.error(`[orbitory-host] ${configPath} is not valid JSON. Fix it or move it aside, then rerun setup.`);
    process.exit(1);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[orbitory-host] ${configPath} must contain a JSON object.`);
    process.exit(1);
  }
  if (parsed.agents !== undefined && !Array.isArray(parsed.agents)) {
    console.error(`[orbitory-host] ${configPath} must contain an "agents" array.`);
    process.exit(1);
  }
  return { ...parsed, agents: parsed.agents ?? [] };
}

function upsertAgent(agents, nextAgent) {
  const filtered = agents.filter((agent) => !agent || typeof agent !== "object" || agent.id !== nextAgent.id);
  return [...filtered, nextAgent];
}

function createProviderConfig(provider, workingDirectory, commandPath, id) {
  switch (provider) {
    case "codex":
      return createCodexProviderConfig(workingDirectory, commandPath, id);
    case "claude":
      return createClaudeProviderConfig(workingDirectory, commandPath, id);
    case "demo":
      return createDemoProviderConfig(workingDirectory, id);
    default:
      throw new Error(`Unknown setup provider: ${provider}`);
  }
}

function createDemoProviderConfig(workingDirectory, id = "demo-terminal") {
  return {
    id,
    displayName: `Demo · ${projectLabel(workingDirectory)}`,
    agentType: "custom",
    command: process.execPath,
    args: [resolve(root, "scripts/demo-agent.js")],
    workingDirectory,
    enabled: true,
    maxRuntimeSeconds: 300,
    sandbox: process.platform === "darwin"
      ? { mode: "sandbox-exec", required: false, allowNetwork: false, allowedWorkingDirectoryOnly: true }
      : { mode: "restricted-process", required: false },
  };
}

function createClaudeProviderConfig(workingDirectory, commandPath = "claude", id = "claude-code-local") {
  return {
    id,
    displayName: `Claude Code · ${projectLabel(workingDirectory)}`,
    agentType: "claudeCode",
    command: commandPath,
    args: [],
    workingDirectory,
    enabled: true,
    io: "stream-json",
    maxRuntimeSeconds: 14_400,
    approvalTimeoutSeconds: 900,
    envAllowlist: providerRuntimeEnvAllowlist("claude"),
    sandbox: realAgentSandbox(),
  };
}

function createCodexProviderConfig(workingDirectory, commandPath = "codex", id = "codex-local") {
  return {
    id,
    displayName: `Codex · ${projectLabel(workingDirectory)}`,
    agentType: "codex",
    command: commandPath,
    args: [],
    workingDirectory,
    enabled: true,
    io: "codex-jsonl",
    maxRuntimeSeconds: 14_400,
    envAllowlist: providerRuntimeEnvAllowlist("codex"),
    sandbox: realAgentSandbox(),
  };
}

function createProviderId(provider) {
  const prefix = provider === "claude" ? "claude" : provider;
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function providerAgentType(provider) {
  return provider === "codex" ? "codex" : provider === "claude" ? "claudeCode" : "custom";
}

function findExistingProvider(agents, provider, workingDirectory) {
  const expectedType = providerAgentType(provider);
  for (const agent of agents) {
    if (
      !agent ||
      typeof agent !== "object" ||
      agent.agentType !== expectedType ||
      typeof agent.id !== "string" ||
      typeof agent.command !== "string" ||
      agent.command.trim().length === 0
    ) {
      continue;
    }
    const configuredDirectory = typeof agent.workingDirectory === "string"
      ? resolve(workingDirectory, agent.workingDirectory)
      : workingDirectory;
    try {
      if (realpathSync(configuredDirectory) === realpathSync(workingDirectory)) return agent;
    } catch {
      // A missing/stale configured directory is not the project being set up.
    }
  }
  return undefined;
}

function projectLabel(workingDirectory) {
  const parts = resolve(workingDirectory).split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? "Project";
}

function writeConfigAtomically(configPath, config) {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function listConfiguredProviders(configPath) {
  const config = loadConfigForSetup(configPath);
  if (config.agents.length === 0) {
    console.log("[orbitory-host] No providers are configured in this folder.");
    return;
  }
  console.log("[orbitory-host] Configured providers:");
  for (const agent of config.agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
    const status = agent.enabled === true ? "enabled" : "disabled";
    const name = typeof agent.displayName === "string" ? agent.displayName : agent.id;
    console.log(`- ${agent.id} (${status}) ${name}`);
  }
}

async function removeConfiguredProvider(configPath, providerId, assumeYes) {
  if (!existsSync(configPath)) {
    console.error(`[orbitory-host] ${configPath} does not exist.`);
    process.exit(1);
  }
  const config = loadConfigForSetup(configPath);
  const target = config.agents.find((agent) => agent && typeof agent === "object" && agent.id === providerId);
  if (!target) {
    console.error(`[orbitory-host] Provider ${JSON.stringify(providerId)} was not found. Use --list-providers.`);
    process.exit(1);
  }

  let confirmed = assumeYes;
  if (!confirmed && input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      const name = typeof target.displayName === "string" ? target.displayName : providerId;
      const answer = (await rl.question(`Remove provider "${name}" (${providerId})? [y/N]: `)).trim().toLowerCase();
      confirmed = answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }
  if (!confirmed) {
    console.error("[orbitory-host] Removal cancelled. Pass --yes for non-interactive confirmation.");
    process.exit(1);
  }

  const nextAgents = config.agents.filter((agent) => !agent || typeof agent !== "object" || agent.id !== providerId);
  const projectCatalog = config.projectCatalog && typeof config.projectCatalog === "object"
    ? { ...config.projectCatalog }
    : undefined;
  if (
    projectCatalog?.codexHistory &&
    typeof projectCatalog.codexHistory === "object" &&
    projectCatalog.codexHistory.providerId === providerId
  ) {
    delete projectCatalog.codexHistory;
  } else if (
    projectCatalog?.codexHistory &&
    typeof projectCatalog.codexHistory === "object" &&
    Array.isArray(projectCatalog.codexHistory.additionalProviderIds)
  ) {
    const remaining = projectCatalog.codexHistory.additionalProviderIds.filter(
      (id) => id !== providerId,
    );
    if (remaining.length > 0) {
      projectCatalog.codexHistory.additionalProviderIds = remaining;
    } else {
      delete projectCatalog.codexHistory.additionalProviderIds;
    }
  }
  if (
    projectCatalog?.creation &&
    typeof projectCatalog.creation === "object" &&
    Array.isArray(projectCatalog.creation.providerIds)
  ) {
    const remaining = projectCatalog.creation.providerIds.filter((id) => id !== providerId);
    if (remaining.length > 0) {
      projectCatalog.creation = { ...projectCatalog.creation, providerIds: remaining };
    } else {
      delete projectCatalog.creation;
    }
  }
  const sanitizedProjectCatalog = projectCatalog && Object.keys(projectCatalog).length > 0
    ? projectCatalog
    : undefined;
  const nextConfig = {
    ...config,
    agents: nextAgents,
  };
  if (sanitizedProjectCatalog) {
    nextConfig.projectCatalog = sanitizedProjectCatalog;
  } else {
    delete nextConfig.projectCatalog;
  }
  writeConfigAtomically(configPath, nextConfig);
  console.log(`[orbitory-host] Removed provider ${providerId}.`);
  console.log("[orbitory-host] If the host is running, tap Refresh in Orbitory.");
}

function realAgentSandbox() {
  return process.platform === "darwin"
    ? { mode: "sandbox-exec", required: true, allowNetwork: true, allowedWorkingDirectoryOnly: true }
    : { mode: "restricted-process", required: false };
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
