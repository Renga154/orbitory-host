/**
 * Phase 17 — public host-agent distribution guardrails.
 *
 * These tests do not publish anything and do not create a public Git repo.
 * They pin the local package/mirror shape so the owner can review a safe
 * artifact before any manual approval gate is crossed.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostAgentDir = path.resolve(here, "..");
const repoRoot = path.resolve(hostAgentDir, "..");
const protectedRoot = fs.existsSync(path.join(repoRoot, "ios")) ? repoRoot : hostAgentDir;
const localUserPath = ["/Users", "satourenware"].join("/");
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
    assert.deepEqual(packageJson.bin, { "orbitory-host": "./bin/orbitory-host.js" });
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

  test("bin wrapper defaults to pairing-code printing and demo sessions without adding execution authority", () => {
    const binPath = path.join(hostAgentDir, "bin/orbitory-host.js");
    const bin = fs.readFileSync(binPath, "utf8");

    assert.match(bin, /^#!\/usr\/bin\/env node/);
    assert.match(bin, /ORBITORY_PRINT_PAIRING_CODE \?\?= "true"/);
    assert.match(bin, /ORBITORY_DEMO_SESSIONS \?\?= "true"/);
    assert.match(bin, /dist\/index\.js/);
    assert.equal(bin.includes("orbitory-dev-token"), false);
    assert.equal(bin.includes("orbitory-test-token"), false);
    assert.equal(bin.includes("command"), false);
    assert.equal(bin.includes("args"), false);
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
      assert.equal(text.includes(localUserPath), false, `${file} contains a local absolute path`);
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

    assert.throws(
      () => preparePublicHostRepo({ out }),
      /--force/,
    );

    preparePublicHostRepo({ out, force: true });
    assert.equal(fs.existsSync(path.join(out, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(out, "README.md")), true);
  });
});
