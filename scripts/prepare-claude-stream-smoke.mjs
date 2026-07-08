#!/usr/bin/env node
/**
 * Prepare a disposable scratch project for the Phase 16 Claude Code
 * stream-json smoke test. This script intentionally does NOT start the
 * host-agent and does NOT run a Claude session.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hostAgentDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(hostAgentDir, "..");
const realRepoRoot = fs.realpathSync.native(repoRoot);
const defaultScratchDir = path.resolve(repoRoot, "..", "orbitory-claude-stream-project");
const markerFile = ".orbitory-smoke-project";
const providerId = "claude-code-stream-smoke";

function usage() {
  return `Usage: node scripts/prepare-claude-stream-smoke.mjs [options]

Creates a disposable scratch project and an external host-agent config for the
manual Claude Code stream-json smoke test. It never starts Claude.

Options:
  --scratch-dir <path>          Scratch project directory.
                                Default: ${defaultScratchDir}
  --config-out <path>           Config file to write.
                                Default: <scratch-dir>/orbitory.claude-stream-smoke.config.json
  --force                       Recreate known smoke files when the marker exists.
  --skip-claude-version-check   Do not run "claude --version".
  --json                        Print machine-readable JSON.
  --help                        Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    scratchDir: defaultScratchDir,
    configOut: null,
    force: false,
    skipClaudeVersionCheck: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (name) => {
      if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--skip-claude-version-check") {
      options.skipClaudeVersionCheck = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--scratch-dir" || arg.startsWith("--scratch-dir=")) {
      options.scratchDir = readValue("--scratch-dir");
    } else if (arg === "--config-out" || arg.startsWith("--config-out=")) {
      options.configOut = readValue("--config-out");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.scratchDir = path.resolve(options.scratchDir);
  options.configOut = path.resolve(options.configOut ?? path.join(options.scratchDir, "orbitory.claude-stream-smoke.config.json"));
  return options;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(targetPath) {
  const absolute = path.resolve(targetPath);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return absolute;
    }
    existing = parent;
  }
  const realExisting = fs.realpathSync.native(existing);
  return path.resolve(realExisting, path.relative(existing, absolute));
}

function assertOutsideRepo(targetPath, label) {
  const absolute = path.resolve(targetPath);
  const realTarget = resolveThroughExistingAncestor(absolute);
  if (isInside(absolute, repoRoot) || isInside(realTarget, realRepoRoot)) {
    throw new Error(
      `${label} must live outside the Orbitory repo.\nrepo: ${repoRoot}\n${label.toLowerCase()}: ${absolute}`,
    );
  }
}

function assertSafeScratchDir(scratchDir) {
  if (scratchDir === path.parse(scratchDir).root) {
    throw new Error("Refusing to use the filesystem root as a scratch project.");
  }
  assertOutsideRepo(scratchDir, "Scratch project");
}

function writeFileIfNeeded(filePath, content, force) {
  if (fs.existsSync(filePath) && !force) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return true;
}

function ensureScratchProject(scratchDir, force) {
  assertSafeScratchDir(scratchDir);
  fs.mkdirSync(scratchDir, { recursive: true });

  const markerPath = path.join(scratchDir, markerFile);
  const entries = fs.readdirSync(scratchDir);
  const hasMarker = fs.existsSync(markerPath);
  if (!hasMarker && entries.length > 0) {
    throw new Error(
      `Refusing to write into a non-empty directory without ${markerFile}: ${scratchDir}`,
    );
  }

  fs.writeFileSync(markerPath, "Orbitory Claude Code stream-json smoke project.\n", { mode: 0o644 });

  const files = new Map([
    [
      "package.json",
      `${JSON.stringify(
        {
          name: "orbitory-claude-stream-smoke",
          private: true,
          type: "module",
          scripts: { test: "node --test" },
        },
        null,
        2,
      )}\n`,
    ],
    [
      "README.md",
      `# Orbitory Claude Code stream smoke scratch

This directory is disposable. It exists only so a logged-in host user can run
the Phase 16 manual Claude Code stream-json smoke test outside the Orbitory
repo.

Suggested phone prompt:

\`\`\`
Run npm test, fix only src/greeter.js so the test passes, then run npm test again.
\`\`\`

Expected first state: \`npm test\` fails because src/greeter.js uses a period
instead of an exclamation mark. A successful smoke leaves the test passing and
records approvals/audit events in the host-agent.
`,
    ],
    [
      ".gitignore",
      `node_modules/
.DS_Store
`,
    ],
    [
      "src/greeter.js",
      `export function greet(name) {
  return \`Hello, \${name}.\`;
}
`,
    ],
    [
      "test/greeter.test.js",
      `import assert from "node:assert/strict";
import { test } from "node:test";

import { greet } from "../src/greeter.js";

test("greet uses an exclamation mark", () => {
  assert.equal(greet("Orbitory"), "Hello, Orbitory!");
});
`,
    ],
    [
      "SMOKE_RESULT.md",
      `# Orbitory Phase 16 real-Claude smoke result

- Date:
- Host:
- Claude Code version:
- Scratch dir:
- Provider id: ${providerId}

## Checks

- [ ] Host-agent started with ORBITORY_AGENT_CONFIG_PATH pointing at this scratch config.
- [ ] iPhone paired and started provider id ${providerId}.
- [ ] Session showed the Real agent badge.
- [ ] Chat from phone reached Claude and assistant reply returned as chat.message.
- [ ] Approval reject path observed.
- [ ] Approval approve path observed.
- [ ] Approval timeout path observed, or explicitly skipped with reason.
- [ ] Stop from phone ended the process honestly.
- [ ] Audit log contains approval events with safe metadata only.
- [ ] No secrets, host paths, commands, argv, env values, or raw output were copied into audit details.

## Notes

`,
    ],
  ]);

  const written = [];
  for (const [relativePath, content] of files) {
    const didWrite = writeFileIfNeeded(path.join(scratchDir, relativePath), content, force);
    if (didWrite) written.push(relativePath);
  }
  return written;
}

function buildConfig(scratchDir) {
  return {
    agents: [
      {
        id: providerId,
        displayName: "Claude Code stream smoke (scratch)",
        agentType: "claudeCode",
        command: "claude",
        args: [],
        workingDirectory: scratchDir,
        enabled: true,
        io: "stream-json",
        maxRuntimeSeconds: 900,
        approvalTimeoutSeconds: 60,
        envAllowlist: ["PATH", "HOME"],
        sandbox: {
          mode: "sandbox-exec",
          required: true,
          allowNetwork: true,
          allowedWorkingDirectoryOnly: true,
        },
      },
    ],
  };
}

function writeConfig(configOut, config) {
  assertOutsideRepo(configOut, "Config file");
  fs.mkdirSync(path.dirname(configOut), { recursive: true });
  fs.writeFileSync(configOut, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configOut, 0o600);
}

function checkClaudeVersion(skip) {
  if (skip) return { skipped: true, ok: true, version: null };
  const result = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error) {
    return { skipped: false, ok: false, version: null, warning: result.error.message };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return { skipped: false, ok: result.status === 0, version: output || null, warning: result.status === 0 ? null : output };
}

function renderHuman(summary) {
  const lines = [
    "Orbitory Claude Code stream smoke prep complete.",
    "",
    `Scratch project: ${summary.scratchDir}`,
    `Config file:     ${summary.configPath}`,
    `Provider id:     ${summary.providerId}`,
  ];

  if (summary.claudeVersion.skipped) {
    lines.push("Claude check:    skipped");
  } else if (summary.claudeVersion.ok) {
    lines.push(`Claude check:    ${summary.claudeVersion.version}`);
  } else {
    lines.push(`Claude check:    not confirmed (${summary.claudeVersion.warning})`);
  }

  lines.push(
    "",
    "Next manual commands:",
    "",
    "  cd host-agent",
    `  ORBITORY_AGENT_CONFIG_PATH=${JSON.stringify(summary.configPath)} ORBITORY_DEMO_SESSIONS=false npm start`,
    "",
    "Then pair the iPhone, start provider claude-code-stream-smoke, and use the prompt in:",
    `  ${path.join(summary.scratchDir, "README.md")}`,
    "",
    "This prep command did not start Claude and did not make API calls.",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const writtenFiles = ensureScratchProject(options.scratchDir, options.force);
  const config = buildConfig(options.scratchDir);
  writeConfig(options.configOut, config);
  const claudeVersion = checkClaudeVersion(options.skipClaudeVersionCheck);

  const summary = {
    ok: true,
    scratchDir: options.scratchDir,
    configPath: options.configOut,
    providerId,
    writtenFiles,
    config,
    claudeVersion,
  };

  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : renderHuman(summary));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`prepare-claude-stream-smoke: ${message}\n`);
  process.exitCode = 1;
}
