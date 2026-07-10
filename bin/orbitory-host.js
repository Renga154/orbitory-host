#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
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
  "--init-config",
  "--setup",
  "--yes",
  "-y",
  "--login-device",
  "--login-browser",
]);
const wantsHelp = extra.includes("--help") || extra.includes("-h");
const wantsDemo = extra.includes("--demo");
const wantsInitConfig = extra.includes("--init-config");
const wantsSetup = extra.includes("--setup");
const wantsYes = extra.includes("--yes") || extra.includes("-y");
const wantsLoginDevice = extra.includes("--login-device");
const wantsLoginBrowser = extra.includes("--login-browser");
const setupProviderArg = extra.find((option) => setupProviderAliases.has(option));
const unknownOption = extra.find((option) => option.startsWith("-") && !supportedOptions.has(option));
const unknownPositional = extra.find((option) => !option.startsWith("-") && !(wantsSetup && setupProviderAliases.has(option)));

if (wantsHelp) {
  console.log(
    [
      "Usage: orbitory-host [--demo] [--setup [codex|claude|demo] [--yes]] [--init-config]",
      "",
      "Starts the local Orbitory host-agent and prints a sensitive pairing QR/code.",
      "By default, the TestFlight app sees only this computer and real configured sessions.",
      "",
      "Options:",
      "  --demo         Seed fake demo hosts/sessions for screenshots or guided exploration.",
      "  --setup        Guided setup for an enabled local AI provider in ./orbitory.config.json.",
      "  --yes, -y      Use defaults with --setup; useful for scripts and quick local setup.",
      "  --login-device Sign in on another device during setup (Codex device code; Claude return code).",
      "  --login-browser Sign in through the provider's official browser flow during setup.",
      "  --init-config  Create ./orbitory.config.json with a safe starter provider, then exit.",
      "",
      "Examples:",
      "  npx orbitory-host@latest --setup",
      "  npx orbitory-host@latest --setup codex --yes",
      "  npx orbitory-host@latest --setup codex --login-device --yes",
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

if (wantsInitConfig && wantsSetup) {
  console.error("[orbitory-host] Choose either --setup or --init-config, not both.");
  process.exit(1);
}

if ((wantsLoginDevice || wantsLoginBrowser) && !wantsSetup) {
  console.error("[orbitory-host] --login-device/--login-browser can only be used with --setup.");
  process.exit(1);
}

if (wantsLoginDevice && wantsLoginBrowser) {
  console.error("[orbitory-host] Choose either --login-device or --login-browser, not both.");
  process.exit(1);
}

if (wantsSetup) {
  await runGuidedSetup({
    requestedProvider: setupProviderArg ? setupProviderAliases.get(setupProviderArg) : undefined,
    assumeYes: wantsYes,
    loginDevice: wantsLoginDevice,
    loginBrowser: wantsLoginBrowser,
  });
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

process.env.ORBITORY_PRINT_PAIRING_CODE ??= "true";
process.env.ORBITORY_DEMO_SESSIONS ??= wantsDemo ? "true" : "false";

await import(pathToFileURL(entrypoint).href);

async function runGuidedSetup({ requestedProvider, assumeYes, loginDevice, loginBrowser }) {
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

    const workingDirectory = assumeYes
      ? process.cwd()
      : await askForWorkingDirectory(rl, process.cwd());
    if (!isDirectory(workingDirectory)) {
      console.error(`[orbitory-host] Project folder not found: ${workingDirectory}`);
      process.exit(1);
    }

    if (provider !== "demo" && !detected[provider]) {
      const displayName = providerDisplayName(provider);
      const installUrl = provider === "codex"
        ? "https://developers.openai.com/codex/cli"
        : "https://code.claude.com/docs/en/setup";
      console.error(`[orbitory-host] ${displayName} CLI was not found. Install it from ${installUrl}, then rerun setup.`);
      console.error("[orbitory-host] No provider configuration was changed.");
      process.exit(1);
    }

    if (provider !== "demo" && detected[provider]) {
      const providerCommand = detected[provider];
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

    const configPath = resolve(workingDirectory, "orbitory.config.json");
    const config = loadConfigForSetup(configPath);
    const providerConfig = createProviderConfig(provider, workingDirectory, detected[provider]);
    const nextConfig = {
      ...config,
      agents: upsertAgent(config.agents, providerConfig),
    };

    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });

    console.log(`[orbitory-host] Updated ${configPath}`);
    console.log(`[orbitory-host] Enabled provider: ${providerConfig.displayName} (${providerConfig.id})`);
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
  });
  return result.status === 0;
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

function createProviderConfig(provider, workingDirectory, commandPath) {
  switch (provider) {
    case "codex":
      return createCodexProviderConfig(workingDirectory, commandPath);
    case "claude":
      return createClaudeProviderConfig(workingDirectory, commandPath);
    case "demo":
      return createDemoProviderConfig(workingDirectory);
    default:
      throw new Error(`Unknown setup provider: ${provider}`);
  }
}

function createDemoProviderConfig(workingDirectory) {
  return {
    id: "demo-terminal",
    displayName: "Demo Terminal Agent",
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

function createClaudeProviderConfig(workingDirectory, commandPath = "claude") {
  return {
    id: "claude-code-local",
    displayName: "Claude Code (this project)",
    agentType: "claudeCode",
    command: commandPath,
    args: [],
    workingDirectory,
    enabled: true,
    io: "stream-json",
    maxRuntimeSeconds: 14_400,
    approvalTimeoutSeconds: 900,
    envAllowlist: ["PATH", "HOME"],
    sandbox: realAgentSandbox(),
  };
}

function createCodexProviderConfig(workingDirectory, commandPath = "codex") {
  return {
    id: "codex-local",
    displayName: "Codex (this project)",
    agentType: "codex",
    command: commandPath,
    args: ["exec"],
    workingDirectory,
    enabled: true,
    maxRuntimeSeconds: 14_400,
    envAllowlist: ["PATH", "HOME", "OPENAI_API_KEY"],
    sandbox: realAgentSandbox(),
  };
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
