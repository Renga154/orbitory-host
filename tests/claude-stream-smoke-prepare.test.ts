/**
 * Phase 16.2 — manual real-Claude smoke prep tests.
 *
 * These tests exercise only the preparation script. They never start the real
 * Claude CLI and never make model/API calls.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostAgentDir = path.resolve(here, "..");
const repoRoot = path.resolve(hostAgentDir, "..");
const scriptPath = path.join(hostAgentDir, "scripts/prepare-claude-stream-smoke.mjs");
const tempRoots: string[] = [];
const repoTempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-claude-smoke-test-"));
  tempRoots.push(dir);
  return dir;
}

function makeRepoTempDir(): string {
  const dir = fs.mkdtempSync(path.join(repoRoot, ".tmp-claude-smoke-test-"));
  repoTempRoots.push(dir);
  return dir;
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: hostAgentDir,
    encoding: "utf8",
  });
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of repoTempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepare-claude-stream-smoke.mjs", () => {
  test("creates a disposable scratch project and enabled external config without running Claude", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    const configOut = path.join(root, "smoke.config.json");

    const result = runScript([
      "--scratch-dir",
      scratchDir,
      "--config-out",
      configOut,
      "--skip-claude-version-check",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      scratchDir: string;
      configPath: string;
      providerId: string;
      claudeVersion: { skipped: boolean };
      config: { agents: Array<Record<string, unknown>> };
    };

    assert.equal(summary.scratchDir, scratchDir);
    assert.equal(summary.configPath, configOut);
    assert.equal(summary.providerId, "claude-code-stream-smoke");
    assert.equal(summary.claudeVersion.skipped, true);
    assert.equal(fs.existsSync(path.join(scratchDir, ".orbitory-smoke-project")), true);
    assert.equal(fs.existsSync(path.join(scratchDir, "README.md")), true);
    assert.equal(fs.existsSync(path.join(scratchDir, "SMOKE_RESULT.md")), true);
    assert.equal(fs.readFileSync(path.join(scratchDir, "src/greeter.js"), "utf8").includes("Hello, ${name}."), true);
    assert.equal(
      fs.readFileSync(path.join(scratchDir, "test/greeter.test.js"), "utf8").includes("Hello, Orbitory!"),
      true,
    );

    const config = JSON.parse(fs.readFileSync(configOut, "utf8")) as { agents: Array<Record<string, unknown>> };
    assert.deepEqual(config, summary.config);
    const agent = config.agents[0];
    assert.ok(agent);
    assert.equal(agent.id, "claude-code-stream-smoke");
    assert.equal(agent.enabled, true);
    assert.equal(agent.command, "claude");
    assert.deepEqual(agent.args, []);
    assert.equal(agent.workingDirectory, scratchDir);
    assert.equal(agent.io, "stream-json");
    assert.equal(agent.approvalTimeoutSeconds, 60);
    assert.deepEqual(agent.envAllowlist, ["PATH", "HOME"]);
    assert.deepEqual(agent.sandbox, {
      mode: "sandbox-exec",
      required: true,
      allowNetwork: true,
      allowedWorkingDirectoryOnly: true,
    });
  });

  test("is idempotent for a marked scratch project", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    const first = runScript(["--scratch-dir", scratchDir, "--skip-claude-version-check", "--json"]);
    const second = runScript(["--scratch-dir", scratchDir, "--skip-claude-version-check", "--json"]);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const summary = JSON.parse(second.stdout) as { writtenFiles: string[] };
    assert.deepEqual(summary.writtenFiles, []);
  });

  test("refuses to prepare a scratch project inside the Orbitory repo", () => {
    const scratchDir = path.join(repoRoot, ".tmp-claude-stream-smoke");
    const result = runScript(["--scratch-dir", scratchDir, "--skip-claude-version-check", "--json"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the Orbitory repo/);
    assert.equal(fs.existsSync(scratchDir), false);
  });

  test("refuses a symlinked scratch project whose real target is inside the Orbitory repo", () => {
    const root = makeTempDir();
    const repoTarget = makeRepoTempDir();
    const scratchLink = path.join(root, "scratch-link");
    fs.symlinkSync(repoTarget, scratchLink, "dir");

    const result = runScript(["--scratch-dir", scratchLink, "--skip-claude-version-check", "--json"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Scratch project must live outside the Orbitory repo/);
    assert.equal(fs.existsSync(path.join(repoTarget, ".orbitory-smoke-project")), false);
  });

  test("refuses to write the enabled smoke config inside the Orbitory repo", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    const configOut = path.join(repoRoot, ".tmp-claude-stream-smoke.config.json");
    const result = runScript([
      "--scratch-dir",
      scratchDir,
      "--config-out",
      configOut,
      "--skip-claude-version-check",
      "--json",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Config file must live outside the Orbitory repo/);
    assert.equal(fs.existsSync(configOut), false);
  });

  test("refuses a config path under a symlinked directory whose real target is inside the Orbitory repo", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    const repoConfigDir = makeRepoTempDir();
    const configLinkDir = path.join(root, "config-link");
    fs.symlinkSync(repoConfigDir, configLinkDir, "dir");
    const configOut = path.join(configLinkDir, "smoke.config.json");

    const result = runScript([
      "--scratch-dir",
      scratchDir,
      "--config-out",
      configOut,
      "--skip-claude-version-check",
      "--json",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Config file must live outside the Orbitory repo/);
    assert.equal(fs.existsSync(path.join(repoConfigDir, "smoke.config.json")), false);
  });

  test("refuses to overwrite an unrelated non-empty directory", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    fs.mkdirSync(scratchDir);
    fs.writeFileSync(path.join(scratchDir, "keep.txt"), "not an Orbitory smoke dir\n");

    const result = runScript(["--scratch-dir", scratchDir, "--skip-claude-version-check", "--json"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-empty directory/);
    assert.equal(fs.existsSync(path.join(scratchDir, "keep.txt")), true);
    assert.equal(fs.existsSync(path.join(scratchDir, ".orbitory-smoke-project")), false);
  });

  test("keeps an overwritten external smoke config chmod 0600", () => {
    const root = makeTempDir();
    const scratchDir = path.join(root, "scratch");
    const configOut = path.join(root, "smoke.config.json");
    fs.writeFileSync(configOut, "{}\n", { mode: 0o644 });
    fs.chmodSync(configOut, 0o644);

    const result = runScript([
      "--scratch-dir",
      scratchDir,
      "--config-out",
      configOut,
      "--skip-claude-version-check",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(configOut).mode & 0o777, 0o600);
  });
});
