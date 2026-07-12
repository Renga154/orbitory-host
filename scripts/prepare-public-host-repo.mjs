#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(scriptDir, "..");
const privateRepoRoot = path.resolve(hostRoot, "..");
const protectedRoot = fs.existsSync(path.join(privateRepoRoot, "ios"))
  ? privateRepoRoot
  : hostRoot;
const markerFileName = ".orbitory-public-host-repo";

export const PUBLIC_ALLOWLIST = Object.freeze([
  ".env.example",
  ".gitignore",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "bin/orbitory-host.js",
  "docs/guide",
  "orbitory.config.example.json",
  "package.json",
  "package-lock.json",
  "scripts/demo-agent.js",
  "scripts/fake-claude-code-stream.js",
  "scripts/fake-claude-code.js",
  "scripts/fake-codex-exec.js",
  "scripts/fake-codex.js",
  "scripts/generate-dev-cert.mjs",
  "scripts/orbitory-approval-bridge.js",
  "scripts/pairing-cli.ts",
  "scripts/prepare-claude-stream-smoke.mjs",
  "scripts/prepare-public-host-repo.mjs",
  "src",
  "shared/fixtures",
  "tests",
  "tsconfig.json",
]);

const COPY_ENTRIES = Object.freeze(
  PUBLIC_ALLOWLIST.map((relative) =>
    relative === "shared/fixtures"
      ? {
          from: fs.existsSync(path.join(hostRoot, "shared/fixtures"))
            ? "shared/fixtures"
            : "../shared/fixtures",
          to: "shared/fixtures",
        }
      : { from: relative, to: relative },
  ),
);

const EXCLUDED_SEGMENTS = new Set([".orbitory", ".orbitory-pack", "dist", "node_modules"]);

function usage() {
  return `Usage: node scripts/prepare-public-host-repo.mjs --out <directory> [--force] [--json]

Copies only the public-safe host-agent allowlist into a separate directory.

Approval gates remain manual:
- This script does not create a GitHub repository.
- This script does not push to a remote.
- This script does not publish to npm.
`;
}

function isInside(candidate, base) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(targetPath) {
  const absolute = path.resolve(targetPath);
  const missingSegments = [];
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingSegments.unshift(path.basename(probe));
    probe = parent;
  }
  const realExisting = fs.realpathSync.native(probe);
  return path.resolve(realExisting, ...missingSegments);
}

function assertOutputOutsidePrivateRepo(outDir) {
  const realOutput = resolveThroughExistingAncestor(outDir);
  const realProtectedRoot = fs.realpathSync.native(protectedRoot);
  if (isInside(realOutput, realProtectedRoot)) {
    throw new Error(`Output directory must live outside the Orbitory source repo: ${outDir}`);
  }
}

function parseArgs(argv) {
  const parsed = { out: undefined, force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function ensureDestination(outDir, force) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    return;
  }

  const stat = fs.lstatSync(outDir);
  if (stat.isSymbolicLink()) {
    throw new Error("Output directory must not be a symlink.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Output path must be a directory.");
  }

  const entries = fs.readdirSync(outDir).filter((entry) => entry !== ".DS_Store");
  const markerPath = path.join(outDir, markerFileName);
  if (entries.length === 0) return;
  if (!fs.existsSync(markerPath)) {
    throw new Error("Output directory is non-empty and is not marked as an Orbitory public host mirror.");
  }
  if (!force) {
    throw new Error("Output directory already contains a prepared mirror. Re-run with --force to refresh it.");
  }

  for (const entry of entries) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
}

function shouldCopy(sourcePath) {
  const relative = path.relative(hostRoot, sourcePath);
  if (relative === "") return true;
  const segments = relative.split(path.sep);
  return !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function copyAllowlist(outDir) {
  const copied = [];
  for (const entry of COPY_ENTRIES) {
    const source = path.resolve(hostRoot, entry.from);
    if (!fs.existsSync(source)) {
      throw new Error(`Allowlisted path is missing: ${entry.to}`);
    }
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlinked allowlist path: ${entry.to}`);
    }
    const destination = path.join(outDir, entry.to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      filter: (candidate) => {
        const candidateStat = fs.lstatSync(candidate);
        if (candidateStat.isSymbolicLink()) {
          throw new Error(`Refusing to copy symlink inside public allowlist: ${path.relative(hostRoot, candidate)}`);
        }
        return shouldCopy(candidate);
      },
    });
    copied.push(entry.to);
  }
  fs.writeFileSync(
    path.join(outDir, markerFileName),
    [
      "This directory was prepared by Orbitory's host-agent public mirror script.",
      "Review, commit, push, and publish steps require explicit owner approval.",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  return copied;
}

export function preparePublicHostRepo(options) {
  const outDir = path.resolve(options.out);
  assertOutputOutsidePrivateRepo(outDir);
  ensureDestination(outDir, Boolean(options.force));
  const copied = copyAllowlist(outDir);
  return { outDir, copied };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.out) {
    throw new Error("--out is required.\n\n" + usage());
  }
  const result = preparePublicHostRepo({ out: args.out, force: args.force });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Prepared public host-agent mirror at ${result.outDir}`);
    console.log(`Copied ${result.copied.length} allowlisted paths.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[orbitory-host] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
