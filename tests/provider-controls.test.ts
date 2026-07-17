import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";

import {
  loadProviderControls,
  resolveProviderSelection,
} from "../src/providerControls.js";

const cachePath = join(tmpdir(), `orbitory-models-${randomBytes(6).toString("hex")}.json`);

afterEach(() => {
  if (existsSync(cachePath)) rmSync(cachePath);
});

function mkWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-${randomBytes(6).toString("hex")}-`));
}

function symlinkType(): "dir" | "file" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

describe("provider controls", () => {
  test("publishes only visible, safe Codex models from the host cache", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "codex-hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "../../bad", display_name: "/Users/private", visibility: "list" },
        ],
      }),
    );

    const controls = loadProviderControls("codex", { codexModelCachePath: cachePath });
    assert.deepEqual(
      controls.models.map((model) => model.id),
      ["default", "gpt-5.5"],
    );
    assert.deepEqual(
      controls.launchProfiles.map((profile) => profile.id),
      ["work", "plan", "review"],
    );
  });

  test("resolves only provider-advertised ids", () => {
    const controls = loadProviderControls("claudeCode");
    assert.deepEqual(resolveProviderSelection(controls, "plan", "sonnet"), {
      launchProfileId: "plan",
      intent: "plan",
      modelId: "sonnet",
      modelCliValue: "sonnet",
      permissionProfileId: "supervised",
      permissionMode: "supervised",
      toolsetId: "none",
      includesMcp: false,
      includesSkills: false,
      skillNames: [],
      claudeMcpServers: {},
      secretLiterals: [],
    });
    assert.equal(resolveProviderSelection(controls, "bypass", "sonnet"), undefined);
    assert.equal(resolveProviderSelection(controls, "work", "raw-model"), undefined);
  });

  test("ignores symlinked skill directories for Claude providers", () => {
    const workspace = mkWorkspace("orbitory-skills-links");
    const skillsRoot = join(workspace, ".claude", "skills");
    mkdirSync(join(skillsRoot, "safe"), { recursive: true });
    mkdirSync(join(skillsRoot, "linked"), { recursive: true });
    writeFileSync(join(skillsRoot, "safe", "SKILL.md"), "# Safe skill\n");
    const outside = mkWorkspace("orbitory-outside-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "# Outside skill\n");
    symlinkSync(outside, join(skillsRoot, "outside-link"), symlinkType());

    const controls = loadProviderControls("claudeCode", { workingDirectory: workspace });
    const skillset = controls.runtimeToolsets.get("project-skills");
    assert.ok(skillset);
    assert.deepEqual(skillset.skillNames, ["safe"]);

    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("rejects skill manifests that escape workspace via symlinked SKILL.md", () => {
    const workspace = mkWorkspace("orbitory-skills-traversal");
    const skillsRoot = join(workspace, ".claude", "skills");
    const safe = join(skillsRoot, "safe");
    const escaped = mkWorkspace("orbitory-skills-manifest-target");
    mkdirSync(escaped, { recursive: true });
    writeFileSync(join(escaped, "SKILL.md"), "# Escaped skill\n");
    mkdirSync(safe, { recursive: true });
    writeFileSync(join(safe, "SKILL.md"), "# Safe skill\n");
    const escapeRoot = join(skillsRoot, "escape");
    mkdirSync(escapeRoot, { recursive: true });
    symlinkSync(join(escaped, "SKILL.md"), join(escapeRoot, "SKILL.md"));

    const controls = loadProviderControls("claudeCode", { workingDirectory: workspace });
    const skillset = controls.runtimeToolsets.get("project-skills");
    assert.ok(skillset);
    assert.deepEqual(skillset.skillNames, ["safe"]);

    rmSync(workspace, { recursive: true, force: true });
    rmSync(escaped, { recursive: true, force: true });
  });

  test("ignores oversize skill manifests above the hard cap", () => {
    const workspace = mkWorkspace("orbitory-skills-size");
    const skillsRoot = join(workspace, ".claude", "skills");
    const valid = join(skillsRoot, "safe");
    const tooLarge = join(skillsRoot, "overflow");
    mkdirSync(valid, { recursive: true });
    mkdirSync(tooLarge, { recursive: true });
    writeFileSync(join(valid, "SKILL.md"), "# Safe skill\n");
    writeFileSync(join(tooLarge, "SKILL.md"), "x".repeat(70 * 1024));
    const controls = loadProviderControls("claudeCode", { workingDirectory: workspace });
    const skillset = controls.runtimeToolsets.get("project-skills");
    assert.ok(skillset);
    assert.deepEqual(skillset.skillNames, ["safe"]);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("accepts valid Claude MCP entries and rejects entries with disallowed MCP keys", () => {
    const workspace = mkWorkspace("orbitory-claude-mcp");
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          allowed: {
            command: "node",
            args: ["--version"],
            env: { SAFE_MARKER: "allowed" },
            type: "stdio",
          },
          forbidden: {
            command: "node",
            args: ["--version"],
            type: "stdio",
            metadata: "forbidden",
          },
          wrongType: {
            command: "node",
            type: "http",
          },
        },
      }),
    );

    const controls = loadProviderControls("claudeCode", { workingDirectory: workspace });
    const toolset = controls.runtimeToolsets.get("project-tools");
    assert.ok(toolset);
    assert.deepEqual(Object.keys(toolset.claudeMcpServers), ["allowed"]);
    assert.equal(toolset.claudeMcpServers.allowed.command, "node");
    assert.deepEqual(toolset.claudeMcpServers.allowed.args, ["--version"]);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("ignores oversized Claude MCP config files above the 256KiB cap", () => {
    const workspace = mkWorkspace("orbitory-claude-mcp-size");
    const padded = "x".repeat(300_000);
    const raw = JSON.stringify({
      mcpServers: {
        allowed: {
          command: "node",
          args: ["--version"],
          type: "stdio",
        },
      },
      pad: padded,
    });
    assert.ok(raw.length > 256 * 1024);
    writeFileSync(join(workspace, ".mcp.json"), raw);

    const controls = loadProviderControls("claudeCode", { workingDirectory: workspace });
    const toolset = controls.runtimeToolsets.get("project-tools");
    assert.ok(toolset);
    assert.equal(Object.keys(toolset.claudeMcpServers).length, 0);
    assert.equal(toolset.descriptor.mcpServerCount, 0);

    rmSync(workspace, { recursive: true, force: true });
  });
});
