/**
 * Phase 17 — public host-agent distribution guardrails.
 *
 * These tests do not publish anything and do not create a public Git repo.
 * They pin the local package/mirror shape so the owner can review a safe
 * artifact before any manual approval gate is crossed.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostAgentDir = path.resolve(here, "..");
const repoRoot = path.resolve(hostAgentDir, "..");
const protectedRoot = fs.existsSync(path.join(repoRoot, "ios")) ? repoRoot : hostAgentDir;
const localHomePath = path.resolve(os.homedir());
const localUserName = os.userInfo().username;
const oldProductName = ["Pocket", "Agent"].join(" ");
const privateProgressDoc = ["docs", "progress.md"].join("/");
const tempRoots: string[] = [];
const protectedTempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-public-host-test-"));
  tempRoots.push(dir);
  return dir;
}

function makeProtectedTempDir(): string {
  const dir = fs.mkdtempSync(path.join(protectedRoot, ".tmp-public-host-test-"));
  protectedTempRoots.push(dir);
  return dir;
}

function makeLoggedInCodexBin(): string {
  const fakeBin = path.join(makeTempDir(), "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return fakeBin;
}

function makeLoggedInClaudeBin(): string {
  const fakeBin = path.join(makeTempDir(), "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
      "if [ \"$1\" = \"-p\" ]; then printf '%s\\n' '{\"is_error\":false,\"result\":\"OK\"}'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return fakeBin;
}

function makeTailscaleStartupHarness(): { binPath: string; capturePath: string } {
  const packageRoot = makeTempDir();
  const binDir = path.join(packageRoot, "bin");
  const distDir = path.join(packageRoot, "dist");
  const capturePath = path.join(packageRoot, "startup-env.json");
  fs.mkdirSync(binDir);
  fs.mkdirSync(distDir);
  fs.copyFileSync(
    path.join(hostAgentDir, "bin/orbitory-host.js"),
    path.join(binDir, "orbitory-host.js"),
  );
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(distDir, "index.js"),
    [
      'import { writeFileSync } from "node:fs";',
      'const capturePath = process.env["ORBITORY_TEST_CAPTURE_PATH"];',
      'if (!capturePath) throw new Error("Missing ORBITORY_TEST_CAPTURE_PATH");',
      "writeFileSync(capturePath, JSON.stringify({",
      '  advertisedHost: process.env["ORBITORY_ADVERTISED_HOST"] ?? null,',
      '  pairingToken: process.env["ORBITORY_PAIRING_TOKEN"] ?? null,',
      '  tlsEnabled: process.env["ORBITORY_TLS_ENABLED"] ?? null,',
      '  tlsCertPath: process.env["ORBITORY_TLS_CERT_PATH"] ?? null,',
      '  tlsKeyPath: process.env["ORBITORY_TLS_KEY_PATH"] ?? null,',
      "}));",
      "",
    ].join("\n"),
  );
  return { binPath: path.join(binDir, "orbitory-host.js"), capturePath };
}

function makeRelayStartupHarness(options: { relayPolicySource?: string } = {}): {
  binPath: string;
  capturePath: string;
  relayPolicyPath: string;
} {
  const packageRoot = makeTempDir();
  const binDir = path.join(packageRoot, "bin");
  const distDir = path.join(packageRoot, "dist");
  const capturePath = path.join(packageRoot, "host-started.txt");
  const relayPolicyPath = path.join(distDir, "relayPolicy.js");
  fs.mkdirSync(binDir);
  fs.mkdirSync(distDir);
  fs.copyFileSync(
    path.join(hostAgentDir, "bin/orbitory-host.js"),
    path.join(binDir, "orbitory-host.js"),
  );
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    relayPolicyPath,
    options.relayPolicySource ??
      [
        'export const RELAY_RELEASE_EVIDENCE = { schemaVersion: 1, status: "no-go" };',
        "export const RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID = undefined;",
        "export function evaluateRelayLaunchGate() {",
        '  return { allowed: false, state: "blocked", blockCodes: ["cryptographic_provider_unapproved"] };',
        "}",
        "",
      ].join("\n"),
  );
  fs.writeFileSync(
    path.join(distDir, "index.js"),
    [
      'import { writeFileSync } from "node:fs";',
      'const capturePath = process.env["ORBITORY_TEST_CAPTURE_PATH"];',
      'if (!capturePath) throw new Error("Missing ORBITORY_TEST_CAPTURE_PATH");',
      'writeFileSync(capturePath, "started");',
      "",
    ].join("\n"),
  );
  return { binPath: path.join(binDir, "orbitory-host.js"), capturePath, relayPolicyPath };
}

function makeFakeTailscaleBin(): { binDir: string; callsPath: string } {
  const binDir = path.join(makeTempDir(), "bin");
  const callsPath = path.join(binDir, "calls.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "tailscale"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" > "$ORBITORY_TEST_TAILSCALE_CALLS"',
      'printf \'%s\' "$ORBITORY_TEST_TAILSCALE_STDOUT"',
      'printf \'%s\' "$ORBITORY_TEST_TAILSCALE_STDERR" >&2',
      'exit "${ORBITORY_TEST_TAILSCALE_EXIT_CODE:-0}"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { binDir, callsPath };
}

function runTailscaleStartup({
  stdout,
  stderr = "",
  exitCode = 0,
  advertisedHost,
  tailscaleAvailable = true,
}: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  advertisedHost?: string;
  tailscaleAvailable?: boolean;
}) {
  const harness = makeTailscaleStartupHarness();
  const fakeTailscale = tailscaleAvailable
    ? makeFakeTailscaleBin()
    : (() => {
        const binDir = path.join(makeTempDir(), "bin");
        fs.mkdirSync(binDir);
        return { binDir, callsPath: path.join(binDir, "calls.log") };
      })();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: tailscaleAvailable
      ? `${fakeTailscale.binDir}${path.delimiter}${process.env["PATH"] ?? ""}`
      : fakeTailscale.binDir,
    ORBITORY_TEST_CAPTURE_PATH: harness.capturePath,
    ORBITORY_TEST_TAILSCALE_CALLS: fakeTailscale.callsPath,
    ORBITORY_TEST_TAILSCALE_STDOUT: stdout,
    ORBITORY_TEST_TAILSCALE_STDERR: stderr,
    ORBITORY_TEST_TAILSCALE_EXIT_CODE: String(exitCode),
    ORBITORY_PAIRING_TOKEN: "tailscale-test-token",
    ORBITORY_TLS_ENABLED: "true",
    ORBITORY_TLS_CERT_PATH: "/private/orbitory-test-cert.pem",
    ORBITORY_TLS_KEY_PATH: "/private/orbitory-test-key.pem",
  };
  if (advertisedHost === undefined) {
    delete env["ORBITORY_ADVERTISED_HOST"];
  } else {
    env["ORBITORY_ADVERTISED_HOST"] = advertisedHost;
  }

  const result = spawnSync(process.execPath, [harness.binPath, "--tailscale"], {
    encoding: "utf8",
    env,
  });
  const captured = fs.existsSync(harness.capturePath)
    ? JSON.parse(fs.readFileSync(harness.capturePath, "utf8")) as Record<string, unknown>
    : undefined;
  return { result, captured, callsPath: fakeTailscale.callsPath };
}

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(hostAgentDir, "package.json"), "utf8")) as Record<string, unknown>;
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new Error(`Unexpected non-file/non-directory in mirror: ${relative}`);
      }
    }
  };
  walk(root);
  return files.sort();
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of protectedTempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("public npm package metadata", () => {
  test("declares the intended orbitory-host package/bin without private-package lockouts", () => {
    const packageJson = readPackageJson();

    assert.equal(packageJson.name, "orbitory-host");
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.license, "MIT");
    assert.deepEqual(packageJson.bin, { "orbitory-host": "bin/orbitory-host.js" });
    assert.deepEqual(packageJson.repository, {
      type: "git",
      url: "git+https://github.com/Renga154/orbitory-host.git",
    });
    assert.match(String(packageJson.description), /Orbitory/);

    const files = packageJson.files as string[];
    assert.ok(Array.isArray(files));
    assert.ok(files.includes("bin/"));
    assert.ok(files.includes("dist/"));
    assert.ok(files.includes("docs/guide/"));
    assert.ok(files.includes(".gitignore"));
    assert.equal(files.some((entry) => entry.includes("ios")), false);
    assert.equal(files.some((entry) => entry.startsWith("../")), false);
  });

  test("bin wrapper defaults to honest live state and makes demo mode explicit", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const bin = fs.readFileSync(binPath, "utf8");

    assert.match(bin, /^#!\/usr\/bin\/env node/);
    assert.match(bin, /ORBITORY_PRINT_PAIRING_CODE \?\?= "true"/);
    assert.match(bin, /--demo/);
    assert.match(bin, /ORBITORY_DEMO_SESSIONS \?\?= wantsDemo \? "true" : "false"/);
    assert.match(bin, /--setup/);
    assert.match(bin, /--init-config/);
    assert.match(bin, /dist\/index\.js/);
    assert.equal(bin.includes("orbitory-dev-token"), false);
    assert.equal(bin.includes("orbitory-test-token"), false);
  });

  test("--help documents private Tailscale startup and its example", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const help = execFileSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });

    assert.match(help, /--tailscale/);
    assert.match(help, /private Tailscale IPv4/);
    assert.match(help, /Overrides ORBITORY_ADVERTISED_HOST for this launch/);
    assert.match(help, /npx orbitory-host@latest --tailscale/);
  });

  test("--help labels Relay as security-gated instead of promising remote access", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const help = execFileSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });

    assert.match(help, /--relay/);
    assert.match(help, /security-gated/i);
    assert.match(help, /does not start a public Relay/i);
  });

  test("--relay fails before the host entrypoint can open a socket", () => {
    const harness = makeRelayStartupHarness();
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORBITORY_TEST_CAPTURE_PATH: harness.capturePath,
        ORBITORY_RELAY_URL: "wss://relay.orbitory.example/connect",
        ORBITORY_RELAY_CRYPTO_PROVIDER: "unreviewed-noise-provider",
        ORBITORY_PAIRING_TOKEN: "relay-test-token",
        ORBITORY_DISABLE_STATIC_TOKEN: "true",
        ORBITORY_RELAY_THREAT_MODEL_REVIEWED: "true",
        ORBITORY_RELAY_CRYPTO_REVIEWED: "true",
        ORBITORY_RELAY_REPLAY_REVIEWED: "true",
        ORBITORY_RELAY_PRIVACY_REVIEWED: "true",
        ORBITORY_RELAY_EXPORT_REVIEWED: "true",
        ORBITORY_RELAY_KILL_SWITCH_ENABLED: "true",
        ORBITORY_RELAY_KEY_STORAGE_REVIEWED: "true",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay security gate blocked startup/);
    assert.match(result.stderr, /cryptographic_provider_unapproved/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay ignores runtime environment claims about release reviews and crypto selection", () => {
    const harness = makeRelayStartupHarness({
      relayPolicySource: [
        'export const RELAY_RELEASE_EVIDENCE = { schemaVersion: 1, status: "no-go", threatModelReviewed: false, cryptographicReviewCompleted: false, replayAndOrderingReviewCompleted: false, privacyReviewCompleted: false, exportComplianceReviewed: false, keyStorageReviewed: false, interoperabilityReviewCompleted: false, revocationReviewCompleted: false, physical4GReviewCompleted: false, soak24HourReviewCompleted: false };',
        "export const RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID = undefined;",
        "export function evaluateRelayLaunchGate(input) {",
        "  const blockCodes = [];",
        '  if (!input.releaseDecisionApproved) blockCodes.push("release_evidence_not_approved");',
        '  if (!input.threatModelReviewed) blockCodes.push("threat_model_review_required");',
        '  if (!input.cryptographicReviewCompleted) blockCodes.push("cryptographic_review_required");',
        '  if (!input.physical4GReviewCompleted) blockCodes.push("physical_4g_review_required");',
        '  if (!input.soak24HourReviewCompleted) blockCodes.push("soak_24_hour_review_required");',
        '  if (!input.cryptographicProviderId) blockCodes.push("cryptographic_provider_unapproved");',
        '  return { allowed: blockCodes.length === 0, state: blockCodes.length === 0 ? "ready" : "blocked", blockCodes };',
        "}",
        "",
      ].join("\n"),
    });
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORBITORY_TEST_CAPTURE_PATH: harness.capturePath,
        ORBITORY_RELAY_URL: "wss://relay.orbitory.example/connect",
        ORBITORY_RELAY_CRYPTO_PROVIDER: "runtime-claimed-provider",
        ORBITORY_PAIRING_TOKEN: "relay-test-token",
        ORBITORY_DISABLE_STATIC_TOKEN: "true",
        ORBITORY_RELAY_THREAT_MODEL_REVIEWED: "true",
        ORBITORY_RELAY_CRYPTO_REVIEWED: "true",
        ORBITORY_RELAY_REPLAY_REVIEWED: "true",
        ORBITORY_RELAY_PRIVACY_REVIEWED: "true",
        ORBITORY_RELAY_EXPORT_REVIEWED: "true",
        ORBITORY_RELAY_KILL_SWITCH_ENABLED: "true",
        ORBITORY_RELAY_KEY_STORAGE_REVIEWED: "true",
        ORBITORY_RELAY_PHYSICAL_4G_REVIEWED: "true",
        ORBITORY_RELAY_SOAK_24_HOUR_REVIEWED: "true",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release_evidence_not_approved/);
    assert.match(result.stderr, /threat_model_review_required/);
    assert.match(result.stderr, /cryptographic_review_required/);
    assert.match(result.stderr, /physical_4g_review_required/);
    assert.match(result.stderr, /soak_24_hour_review_required/);
    assert.match(result.stderr, /cryptographic_provider_unapproved/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay fails closed when compiled release evidence is missing", () => {
    const harness = makeRelayStartupHarness({
      relayPolicySource: [
        "export function evaluateRelayLaunchGate() {",
        '  return { allowed: true, state: "ready", blockCodes: [] };',
        "}",
        "",
      ].join("\n"),
    });
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: { ...process.env, ORBITORY_TEST_CAPTURE_PATH: harness.capturePath },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release evidence is missing or invalid/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay still fails closed if a future reviewed gate returns allowed", () => {
    const harness = makeRelayStartupHarness({
      relayPolicySource: [
        'export const RELAY_RELEASE_EVIDENCE = { schemaVersion: 1, status: "go" };',
        'export const RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID = "reviewed-provider";',
        "export function evaluateRelayLaunchGate() {",
        '  return { allowed: true, state: "ready", blockCodes: [] };',
        "}",
        "",
      ].join("\n"),
    });
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORBITORY_TEST_CAPTURE_PATH: harness.capturePath,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay transport is not bundled in this release/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay fails closed when its security gate file is missing", () => {
    const harness = makeRelayStartupHarness();
    fs.rmSync(harness.relayPolicyPath);

    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: { ...process.env, ORBITORY_TEST_CAPTURE_PATH: harness.capturePath },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay security gate is missing/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay fails closed when its security gate cannot be imported", () => {
    const harness = makeRelayStartupHarness({ relayPolicySource: "export function {\n" });
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: { ...process.env, ORBITORY_TEST_CAPTURE_PATH: harness.capturePath },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay security gate could not be loaded/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay fails closed when its security gate export is invalid", () => {
    const harness = makeRelayStartupHarness({
      relayPolicySource: "export const evaluateRelayLaunchGate = null;\n",
    });
    const result = spawnSync(process.execPath, [harness.binPath, "--relay"], {
      encoding: "utf8",
      env: { ...process.env, ORBITORY_TEST_CAPTURE_PATH: harness.capturePath },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay security gate is invalid/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(fs.existsSync(harness.capturePath), false);
  });

  test("--relay and --tailscale cannot be combined", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const result = spawnSync(process.execPath, [binPath, "--relay", "--tailscale"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Choose either --relay or --tailscale/);
  });

  test("--tailscale starts with the private CLI IPv4 without changing token or TLS settings", () => {
    const { result, captured, callsPath } = runTailscaleStartup({ stdout: "100.100.23.45\n" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(callsPath, "utf8"), "ip -4\n");
    assert.deepEqual(captured, {
      advertisedHost: "100.100.23.45",
      pairingToken: "tailscale-test-token",
      tlsEnabled: "true",
      tlsCertPath: "/private/orbitory-test-cert.pem",
      tlsKeyPath: "/private/orbitory-test-key.pem",
    });
  });

  test("--tailscale fails closed when the CLI is logged out even if an advertised host exists", () => {
    const { result, captured } = runTailscaleStartup({
      stdout: "",
      stderr: "Logged out.\n",
      exitCode: 1,
      advertisedHost: "100.70.1.2",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tailscale is running and logged in/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(captured, undefined);
  });

  test("--tailscale overrides an explicit advertised host with the detected tailnet IPv4", () => {
    const { result, captured } = runTailscaleStartup({
      stdout: "100.127.255.255\n",
      advertisedHost: "203.0.113.42",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(captured?.advertisedHost, "100.127.255.255");
  });

  test("--tailscale rejects output with an extra newline", () => {
    const { result, captured } = runTailscaleStartup({ stdout: "100.64.0.1\n\n" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly one IPv4 in 100\.64\.0\.0\/10/);
    assert.equal(captured, undefined);
  });

  test("--tailscale rejects multiple IPv4 values instead of choosing one", () => {
    const { result, captured } = runTailscaleStartup({
      stdout: "100.64.0.1\n100.127.255.254\n",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly one IPv4 in 100\.64\.0\.0\/10/);
    assert.equal(captured, undefined);
  });

  test("--tailscale accepts no malformed, non-CGNAT, hostname, or URL output", () => {
    const rejectedOutputs = [
      ["malformed IPv4", "100.64.0.999\n"],
      ["below CGNAT", "100.63.255.255\n"],
      ["above CGNAT", "100.128.0.0\n"],
      ["LAN IPv4", "192.168.1.10\n"],
      ["hostname", "orbitory-host.example.ts.net\n"],
      ["URL", "https://orbitory-host.example.ts.net\n"],
    ] as const;

    for (const [label, stdout] of rejectedOutputs) {
      const { result, captured } = runTailscaleStartup({ stdout });
      assert.equal(result.status, 1, `${label} must be rejected`);
      assert.match(result.stderr, /Expected exactly one IPv4 in 100\.64\.0\.0\/10/, label);
      assert.equal(captured, undefined, `${label} must not start the host`);
    }
  });

  test("--tailscale fails closed with a clear error when the CLI is unavailable", () => {
    const { result, captured } = runTailscaleStartup({
      stdout: "",
      tailscaleAvailable: false,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tailscale CLI was not found on PATH/);
    assert.match(result.stderr, /no host was started/);
    assert.equal(captured, undefined);
  });

  test("--init-config writes a local starter config and does not require built dist files", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();

    execFileSync(process.execPath, [binPath, "--init-config"], { cwd, encoding: "utf8" });

    const configPath = path.join(cwd, "orbitory.config.json");
    assert.equal(fs.existsSync(configPath), true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    const demo = config.agents.find((agent) => agent.id === "demo-terminal");
    const claude = config.agents.find((agent) => agent.id === "claude-code-local");
    const codex = config.agents.find((agent) => agent.id === "codex-local");
    assert.equal(demo?.enabled, true);
    assert.equal(demo?.command, process.execPath);
    assert.ok(Array.isArray(demo?.args));
    assert.match(String((demo?.args as string[])[0]), /scripts\/demo-agent\.js$/);
    assert.equal(claude?.enabled, false);
    assert.equal(codex?.enabled, false);
    assert.equal(fs.realpathSync(String(claude?.workingDirectory)), fs.realpathSync(cwd));
    assert.equal(fs.realpathSync(String(codex?.workingDirectory)), fs.realpathSync(cwd));
  });

  test("--setup codex --yes writes an enabled provider without manual JSON editing", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = makeLoggedInCodexBin();

    const output = execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });

    assert.match(output, /Enabled provider: Codex · orbitory-public-host-test-/);
    assert.match(output, /host is already running, tap Refresh/);
    assert.match(output, /If no host is running, start it from this folder with `npx orbitory-host@latest`/);

    const configPath = path.join(cwd, "orbitory.config.json");
    assert.equal(fs.existsSync(configPath), true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    assert.equal(config.agents.length, 1);
    const codex = config.agents[0];
    assert.match(String(codex.id), /^codex-[a-f0-9]{10}$/);
    assert.equal(codex.enabled, true);
    assert.equal(path.basename(String(codex.command)), "codex");
    assert.deepEqual(codex.args, []);
    assert.equal(codex.io, "codex-jsonl");
    assert.deepEqual(codex.envAllowlist, ["PATH", "HOME", "OPENAI_API_KEY"]);
    assert.equal(fs.realpathSync(String(codex.workingDirectory)), fs.realpathSync(cwd));
  });

  test("--setup claude preserves the user identity required by runtime authentication", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = makeLoggedInClaudeBin();

    execFileSync(process.execPath, [binPath, "--setup", "claude", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });

    const config = JSON.parse(
      fs.readFileSync(path.join(cwd, "orbitory.config.json"), "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    assert.deepEqual(config.agents[0]?.envAllowlist, ["PATH", "HOME", "USER", "LOGNAME"]);
  });

  test("--setup claude prefers the configured CLI when PATH contains a stale duplicate", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const configuredBin = makeLoggedInClaudeBin();
    const configuredClaude = path.join(configuredBin, "claude");
    const staleBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(staleBin);
    fs.writeFileSync(
      path.join(staleBin, "claude"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(cwd, "orbitory.config.json"),
      `${JSON.stringify({
        agents: [
          {
            id: "claude-existing",
            displayName: "Claude Code existing",
            agentType: "claudeCode",
            command: configuredClaude,
            args: [],
            workingDirectory: cwd,
            enabled: true,
            io: "stream-json",
          },
        ],
      }, null, 2)}\n`,
    );

    const result = spawnSync(process.execPath, [binPath, "--setup", "claude", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${staleBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(cwd, "orbitory.config.json"), "utf8")) as {
      agents: Array<{ id: string; command: string }>;
    };
    assert.equal(config.agents[0]?.id, "claude-existing");
    assert.equal(config.agents[0]?.command, configuredClaude);
  });

  test("--setup claude rejects authentication that depends on an environment value runtime strips", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "claude"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ] && [ -n \"$FULL_ENV_ONLY_AUTH\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync(process.execPath, [binPath, "--setup", "claude", "--yes"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
        FULL_ENV_ONLY_AUTH: "must-not-reach-runtime-check",
      },
    });

    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), false);
  });

  test("--setup claude rejects stale credentials even when auth status claims logged in", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "claude"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "if [ \"$1\" = \"-p\" ]; then",
        "  printf '%s\\n' '{\"is_error\":true,\"result\":\"Failed to authenticate. API Error: 401\"}'",
        "  exit 1",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync(process.execPath, [binPath, "--setup", "claude", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Claude Code is not logged in/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), false);
  });

  test("--setup reports an existing Codex login as ready", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
        "  echo \"Logged in using ChatGPT\"",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const output = execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
    });

    assert.match(output, /Codex login: ready/);
  });

  test("--setup pins the detected provider executable instead of relying on the host PATH", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      "#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi\nexit 1\n",
      { mode: 0o700 },
    );

    execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
    });

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "orbitory.config.json"), "utf8")) as {
      agents: Array<{ command: string }>;
    };
    assert.equal(config.agents[0]?.command, fakeCodex);
  });

  test("--setup can complete Codex login with the phone-friendly device flow", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    const stateFile = path.join(fakeBin, "logged-in");
    const callsFile = path.join(fakeBin, "calls.log");
    fs.mkdirSync(fakeBin);
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        `echo \"$@\" >> \"${callsFile}\"`,
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
        `  test -f \"${stateFile}\"`,
        "  exit $?",
        "fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"--device-auth\" ]; then",
        `  touch \"${stateFile}\"`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const output = execFileSync(
      process.execPath,
      [binPath, "--setup", "codex", "--yes", "--login-device"],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
      },
    );

    assert.match(output, /Starting Codex device login/);
    assert.match(output, /Codex login: ready/);
    assert.match(fs.readFileSync(callsFile, "utf8"), /login --device-auth/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), true);
  });

  test("--setup can complete Claude Code login in the provider's official browser flow", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    const stateFile = path.join(fakeBin, "logged-in");
    const callsFile = path.join(fakeBin, "calls.log");
    fs.mkdirSync(fakeBin);
    const fakeClaude = path.join(fakeBin, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/bin/sh",
        `echo \"$@\" >> \"${callsFile}\"`,
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        `  test -f \"${stateFile}\"`,
        "  exit $?",
        "fi",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"login\" ]; then",
        `  touch \"${stateFile}\"`,
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"-p\" ]; then",
        `  test -f \"${stateFile}\"`,
        "  exit $?",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const output = execFileSync(
      process.execPath,
      [binPath, "--setup", "claude", "--yes", "--login-browser"],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
      },
    );

    assert.match(output, /Starting Claude Code browser login/);
    assert.match(output, /Claude Code login: ready/);
    assert.match(fs.readFileSync(callsFile, "utf8"), /auth login/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), true);
  });

  test("interactive setup offers phone login without requiring a CLI flag", {
    skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/expect"),
  }, () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    const stateFile = path.join(fakeBin, "logged-in");
    const callsFile = path.join(fakeBin, "calls.log");
    fs.mkdirSync(fakeBin);
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        `echo \"$@\" >> \"${callsFile}\"`,
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
        `  test -f \"${stateFile}\"`,
        "  exit $?",
        "fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"--device-auth\" ]; then",
        `  touch \"${stateFile}\"`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const expectProgram = [
      "set timeout 10",
      "spawn $env(ORBITORY_TEST_NODE) $env(ORBITORY_TEST_BIN) --setup codex",
      "expect {",
      "  -re {Project folder .*:} { send \"\\r\" }",
      "  eof { exit 2 }",
      "  timeout { exit 3 }",
      "}",
      "expect {",
      "  -re {Sign in .*:} { send \"phone\\r\" }",
      "  eof { exit 4 }",
      "  timeout { exit 5 }",
      "}",
      "expect {",
      "  -re {Enable recent Codex projects.*:} { send \"n\\r\" }",
      "  eof { exit 6 }",
      "  timeout { exit 7 }",
      "}",
      "expect {",
      "  -re {Allow new project creation.*:} { send \"n\\r\" }",
      "  eof { exit 8 }",
      "  timeout { exit 9 }",
      "}",
      "expect eof",
      "set result [wait]",
      "exit [lindex $result 3]",
    ].join("\n");
    const result = spawnSync("expect", ["-c", expectProgram], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        ORBITORY_TEST_NODE: process.execPath,
        ORBITORY_TEST_BIN: binPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(callsFile, "utf8"), /login --device-auth/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), true);
  });

  test("interactive setup skips the login question when Codex is already authenticated", {
    skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/expect"),
  }, () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "codex"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const expectProgram = [
      "set timeout 10",
      "spawn $env(ORBITORY_TEST_NODE) $env(ORBITORY_TEST_BIN) --setup codex",
      "expect {",
      "  -re {Project folder .*:} { send \"\\r\" }",
      "  eof { exit 2 }",
      "  timeout { exit 3 }",
      "}",
      "expect {",
      "  -re {Sign in .*:} { exit 6 }",
      "  -re {Enable recent Codex projects.*:} { send \"n\\r\" }",
      "  eof { exit 4 }",
      "  timeout { exit 5 }",
      "}",
      "expect {",
      "  -re {Allow new project creation.*:} { send \"n\\r\" }",
      "  eof { exit 7 }",
      "  timeout { exit 8 }",
      "}",
      "expect {",
      "  -re {Enabled provider: Codex} {}",
      "  eof { exit 9 }",
      "  timeout { exit 10 }",
      "}",
      "expect eof",
      "set result [wait]",
      "exit [lindex $result 3]",
    ].join("\n");
    const result = spawnSync("expect", ["-c", expectProgram], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        ORBITORY_TEST_NODE: process.execPath,
        ORBITORY_TEST_BIN: binPath,
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test("non-interactive setup refuses to enable an installed but logged-out Codex", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = path.join(makeTempDir(), "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });

    const result = spawnSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /codex login/);
    assert.match(result.stderr, /codex login --device-auth/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), false);
  });

  test("setup refuses to enable a real provider whose CLI is not installed", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const result = spawnSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Codex CLI was not found/);
    assert.match(result.stderr, /developers\.openai\.com\/codex/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), false);
  });

  test("--setup merges into an existing config by replacing only the selected provider", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = makeLoggedInCodexBin();
    const configPath = path.join(cwd, "orbitory.config.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        note: "keep me",
        agents: [
          {
            id: "demo-terminal",
            displayName: "Existing Demo",
            agentType: "custom",
            command: process.execPath,
            args: ["old.js"],
            workingDirectory: cwd,
            enabled: true,
          },
          {
            id: "codex-local",
            displayName: "Old Codex",
            agentType: "codex",
            command: "codex",
            args: ["old"],
            workingDirectory: cwd,
            enabled: false,
          },
        ],
      }, null, 2)}\n`,
    );

    execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });

    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      note: string;
      agents: Array<Record<string, unknown>>;
    };
    assert.equal(config.note, "keep me");
    assert.equal(config.agents.length, 2);
    const demo = config.agents.find((agent) => agent.id === "demo-terminal");
    const codex = config.agents.find((agent) => agent.id === "codex-local");
    assert.equal(demo?.displayName, "Existing Demo");
    assert.match(String(codex?.displayName), /^Codex · orbitory-public-host-test-/);
    assert.equal(codex?.enabled, true);
    assert.deepEqual(codex?.args, []);
    assert.equal(codex?.io, "codex-jsonl");
  });

  test("Codex history needs an explicit setup flag and provider removal is host-local", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = makeLoggedInCodexBin();
    const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` };

    execFileSync(
      process.execPath,
      [binPath, "--setup", "codex", "--include-codex-projects", "--yes"],
      { cwd, encoding: "utf8", env },
    );
    const configPath = path.join(cwd, "orbitory.config.json");
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
      projectCatalog: { codexHistory: { enabled: boolean; providerId: string } };
    };
    const providerId = String(configured.agents[0]?.id);
    assert.equal(configured.projectCatalog.codexHistory.enabled, true);
    assert.equal(configured.projectCatalog.codexHistory.providerId, providerId);

    execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env,
    });
    const revoked = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      projectCatalog?: { codexHistory?: unknown };
    };
    assert.equal(
      revoked.projectCatalog?.codexHistory,
      undefined,
      "rerunning setup without the explicit history flag must revoke broad access",
    );

    execFileSync(
      process.execPath,
      [binPath, "--setup", "codex", "--include-codex-projects", "--yes"],
      { cwd, encoding: "utf8", env },
    );

    const listed = execFileSync(process.execPath, [binPath, "--list-providers"], {
      cwd,
      encoding: "utf8",
    });
    assert.match(listed, new RegExp(providerId));

    execFileSync(process.execPath, [binPath, "--remove-provider", providerId, "--yes"], {
      cwd,
      encoding: "utf8",
    });
    const removed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: unknown[];
      projectCatalog?: { codexHistory?: unknown };
    };
    assert.equal(removed.agents.length, 0);
    assert.equal(removed.projectCatalog?.codexHistory, undefined);
  });

  test("Claude setup can explicitly share the recent Codex project catalog", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const codexBin = makeLoggedInCodexBin();
    const claudeBin = makeLoggedInClaudeBin();
    const env = {
      ...process.env,
      PATH: `${codexBin}${path.delimiter}${claudeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    };

    execFileSync(
      process.execPath,
      [binPath, "--setup", "codex", "--include-codex-projects", "--yes"],
      { cwd, encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [binPath, "--setup", "claude", "--include-recent-projects", "--yes"],
      { cwd, encoding: "utf8", env },
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(cwd, "orbitory.config.json"), "utf8"),
    ) as {
      agents: Array<{ id: string; agentType: string }>;
      projectCatalog: { codexHistory: { additionalProviderIds?: string[] } };
    };
    const claudeId = config.agents.find((agent) => agent.agentType === "claudeCode")?.id;
    assert.ok(claudeId);
    assert.deepEqual(config.projectCatalog.codexHistory.additionalProviderIds, [claudeId]);
  });

  test("new project creation is explicit, host-bounded, preserved, and revoked with providers", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const projectRoot = path.join(cwd, "new-projects");
    fs.mkdirSync(projectRoot);
    const codexBin = makeLoggedInCodexBin();
    const claudeBin = makeLoggedInClaudeBin();
    const env = {
      ...process.env,
      PATH: `${codexBin}${path.delimiter}${claudeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    };

    execFileSync(
      process.execPath,
      [
        binPath,
        "--setup",
        "codex",
        "--allow-project-creation",
        "--project-root",
        projectRoot,
        "--yes",
      ],
      { cwd, encoding: "utf8", env },
    );
    const configPath = path.join(cwd, "orbitory.config.json");
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: Array<{ id: string; agentType: string }>;
      projectCatalog: {
        creation: {
          enabled: boolean;
          rootDirectory: string;
          providerIds: string[];
          maxProjects: number;
        };
      };
    };
    const codexId = configured.agents.find((agent) => agent.agentType === "codex")?.id;
    assert.ok(codexId);
    assert.deepEqual(configured.projectCatalog.creation, {
      enabled: true,
      rootDirectory: fs.realpathSync(projectRoot),
      providerIds: [codexId],
      maxProjects: 100,
    });

    execFileSync(process.execPath, [binPath, "--setup", "codex", "--yes"], {
      cwd,
      encoding: "utf8",
      env,
    });
    const preserved = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      projectCatalog: { creation: { providerIds: string[] } };
    };
    assert.deepEqual(preserved.projectCatalog.creation.providerIds, [codexId]);

    execFileSync(
      process.execPath,
      [
        binPath,
        "--setup",
        "claude",
        "--allow-project-creation",
        "--project-root",
        projectRoot,
        "--yes",
      ],
      { cwd, encoding: "utf8", env },
    );
    const shared = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents: Array<{ id: string; agentType: string }>;
      projectCatalog: { creation: { providerIds: string[] } };
    };
    const claudeId = shared.agents.find((agent) => agent.agentType === "claudeCode")?.id;
    assert.ok(claudeId);
    assert.deepEqual(shared.projectCatalog.creation.providerIds, [codexId, claudeId]);

    execFileSync(process.execPath, [binPath, "--remove-provider", codexId, "--yes"], {
      cwd,
      encoding: "utf8",
    });
    const afterCodexRemoval = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      projectCatalog: { creation: { providerIds: string[] } };
    };
    assert.deepEqual(afterCodexRemoval.projectCatalog.creation.providerIds, [claudeId]);

    execFileSync(process.execPath, [binPath, "--remove-provider", claudeId, "--yes"], {
      cwd,
      encoding: "utf8",
    });
    const afterClaudeRemoval = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      projectCatalog?: unknown;
    };
    assert.equal(afterClaudeRemoval.projectCatalog, undefined);
  });

  test("project root cannot be supplied without explicit project-creation consent", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const cwd = makeTempDir();
    const fakeBin = makeLoggedInCodexBin();
    const result = spawnSync(
      process.execPath,
      [binPath, "--setup", "codex", "--project-root", cwd, "--yes"],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}` },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--project-root requires --allow-project-creation/);
    assert.equal(fs.existsSync(path.join(cwd, "orbitory.config.json")), false);
  });
});

describe("prepare-public-host-repo.mjs", () => {
  test("copies only the public host-agent allowlist to an external mirror", async () => {
    const { preparePublicHostRepo, PUBLIC_ALLOWLIST } = await import("../scripts/prepare-public-host-repo.mjs");
    const out = path.join(makeTempDir(), "orbitory-host");

    const result = preparePublicHostRepo({ out });

    assert.equal(result.outDir, out);
    assert.deepEqual(result.copied, [...PUBLIC_ALLOWLIST]);
    assert.equal(fs.existsSync(path.join(out, ".orbitory-public-host-repo")), true);
    assert.equal(fs.existsSync(path.join(out, "README.md")), true);
    assert.equal(fs.existsSync(path.join(out, ".gitignore")), true);
    assert.equal(fs.existsSync(path.join(out, "SECURITY.md")), true);
    assert.equal(fs.existsSync(path.join(out, "LICENSE")), true);
    assert.equal(fs.existsSync(path.join(out, "bin/orbitory-host.js")), true);
    assert.equal(fs.existsSync(path.join(out, "scripts/prepare-public-host-repo.mjs")), true);
    const codexExecFixture = path.join(out, "scripts/fake-codex-exec.js");
    assert.equal(fs.existsSync(codexExecFixture), true);
    assert.notEqual(fs.statSync(codexExecFixture).mode & 0o111, 0, "Codex fixture must remain executable");
    assert.equal(fs.existsSync(path.join(out, "src/index.ts")), true);
    assert.equal(fs.existsSync(path.join(out, "shared/fixtures/session.snapshot.json")), true);
    assert.equal(fs.existsSync(path.join(out, "docs/guide/en/setup.md")), true);
    assert.equal(fs.existsSync(path.join(out, "docs/guide/ja/setup.md")), true);
    assert.equal(fs.existsSync(path.join(out, "dist")), false);
    assert.equal(fs.existsSync(path.join(out, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(out, ".orbitory")), false);
    assert.equal(fs.existsSync(path.join(out, "ios")), false);
    assert.equal(fs.existsSync(path.join(out, privateProgressDoc)), false);

    const publicPackage = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")) as { name: string };
    assert.equal(publicPackage.name, "orbitory-host");

    const copiedFiles = collectFiles(out);
    assert.equal(copiedFiles.some((file) => file.startsWith("ios/")), false);
    assert.equal(copiedFiles.some((file) => file.includes("/.orbitory/")), false);
    assert.equal(copiedFiles.some((file) => file.includes("/node_modules/")), false);

    const textFiles = copiedFiles.filter((file) => /\.(md|json|ts|js|mjs|example|yml|yaml)$/.test(file));
    for (const file of textFiles) {
      const text = fs.readFileSync(path.join(out, file), "utf8");
      assert.equal(text.includes(localHomePath), false, `${file} contains the maintainer home path`);
      assert.equal(
        text.includes(`/Users/${localUserName}`) || text.includes(`/home/${localUserName}`),
        false,
        `${file} contains the maintainer username in an absolute path`,
      );
      assert.equal(text.includes(oldProductName), false, `${file} contains the old product name`);
    }
  });

  test("refuses to prepare a mirror inside the private repo", async () => {
    const { preparePublicHostRepo } = await import("../scripts/prepare-public-host-repo.mjs");
    const out = path.join(protectedRoot, ".tmp-public-host-mirror");

    assert.throws(
      () => preparePublicHostRepo({ out }),
      /outside the Orbitory source repo/,
    );
    assert.equal(fs.existsSync(out), false);
  });

  test("refuses a symlinked output whose real target is inside the private repo", async () => {
    const { preparePublicHostRepo } = await import("../scripts/prepare-public-host-repo.mjs");
    const root = makeTempDir();
    const repoTarget = makeProtectedTempDir();
    const out = path.join(root, "mirror-link");
    fs.symlinkSync(repoTarget, out, "dir");

    assert.throws(
      () => preparePublicHostRepo({ out }),
      /outside the Orbitory source repo/,
    );
    assert.deepEqual(fs.readdirSync(repoTarget), []);
  });

  test("requires --force to refresh an existing marked mirror", async () => {
    const { preparePublicHostRepo } = await import("../scripts/prepare-public-host-repo.mjs");
    const out = path.join(makeTempDir(), "orbitory-host");
    preparePublicHostRepo({ out });
    fs.writeFileSync(path.join(out, "stale.txt"), "stale\n");
    const gitSentinel = path.join(out, ".git", "orbitory-test-sentinel");
    fs.mkdirSync(path.dirname(gitSentinel), { recursive: true });
    fs.writeFileSync(gitSentinel, "preserve public mirror history\n", "utf8");

    assert.throws(
      () => preparePublicHostRepo({ out }),
      /--force/,
    );

    preparePublicHostRepo({ out, force: true });
    assert.equal(fs.existsSync(path.join(out, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(out, "README.md")), true);
    assert.equal(fs.readFileSync(gitSentinel, "utf8"), "preserve public mirror history\n");
  });
});
