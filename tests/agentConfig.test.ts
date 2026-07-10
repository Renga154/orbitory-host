/**
 * Unit tests for the host-side terminal-agent allowlist loader
 * (src/agentConfig.ts). These call `loadAgentConfigs(path)` directly against
 * temp fixture files — no server/WebSocket involved — so they're fast and
 * exercise every validation rule in isolation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAgentConfigs, refreshAgentConfigs } from "../src/agentConfig.js";

function writeTempConfig(content: unknown): { configPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-agentconfig-test-"));
  const configPath = path.join(tempDir, "orbitory.config.json");
  fs.writeFileSync(configPath, typeof content === "string" ? content : JSON.stringify(content));
  return { configPath, tempDir };
}

describe("loadAgentConfigs", () => {
  test("missing config file -> empty map, no throw", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-agentconfig-test-"));
    const missingPath = path.join(tempDir, "does-not-exist.json");
    const configs = loadAgentConfigs(missingPath);
    assert.equal(configs.size, 0);
  });

  test("valid enabled entry is loaded with workingDirectory resolved to an absolute path", () => {
    const { configPath, tempDir } = writeTempConfig({
      agents: [
        {
          id: "valid-agent",
          displayName: "Valid Agent",
          command: "node",
          args: ["--version"],
          workingDirectory: ".",
          enabled: true,
        },
      ],
    });

    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 1);
    const entry = configs.get("valid-agent");
    assert.ok(entry);
    assert.equal(entry.id, "valid-agent");
    assert.equal(entry.displayName, "Valid Agent");
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["--version"]);
    assert.equal(path.isAbsolute(entry.workingDirectory), true);
    assert.equal(entry.workingDirectory, path.resolve(tempDir));
  });

  test("entry with enabled: false is excluded", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "disabled-agent", command: "node", args: [], workingDirectory: ".", enabled: false },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 0);
  });

  test("entry with enabled omitted is excluded (fail-closed default)", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-enabled-field", command: "node", args: [], workingDirectory: "." }],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 0);
  });

  test("entry missing id is excluded; other valid entries in the same file still load", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { command: "node", args: [], workingDirectory: ".", enabled: true },
        { id: "second-valid", command: "node", args: [], workingDirectory: ".", enabled: true },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 1);
    assert.ok(configs.has("second-valid"));
  });

  test("entry missing command is excluded", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-command", args: [], workingDirectory: ".", enabled: true }],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 0);
  });

  test("entry with a nonexistent workingDirectory is excluded", () => {
    const { configPath } = writeTempConfig({
      agents: [
        {
          id: "bad-cwd",
          command: "node",
          args: [],
          workingDirectory: "./this/path/does/not/exist",
          enabled: true,
        },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 0);
  });

  test("duplicate ids: only the first is kept", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "dupe", displayName: "First", command: "node", args: [], workingDirectory: ".", enabled: true },
        { id: "dupe", displayName: "Second", command: "node", args: [], workingDirectory: ".", enabled: true },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 1);
    assert.equal(configs.get("dupe")?.displayName, "First");
  });

  test("malformed JSON -> empty map, does not throw", () => {
    const { configPath } = writeTempConfig("{ this is not valid json");
    assert.doesNotThrow(() => loadAgentConfigs(configPath));
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("file without an agents array -> empty map, does not throw", () => {
    const { configPath } = writeTempConfig({ notAgents: [] });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 0);
  });

  test("args defaults to an empty array when omitted", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-args", command: "node", workingDirectory: ".", enabled: true }],
    });
    const configs = loadAgentConfigs(configPath);
    assert.deepEqual(configs.get("no-args")?.args, []);
  });

  test("displayName defaults to id when omitted", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-display-name", command: "node", workingDirectory: ".", enabled: true }],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.get("no-display-name")?.displayName, "no-display-name");
  });
});

describe("refreshAgentConfigs", () => {
  test("loads a provider added after the host process started", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-agentconfig-refresh-test-"));
    const configPath = path.join(tempDir, "orbitory.config.json");
    const liveConfigs = new Map();

    assert.equal(refreshAgentConfigs(configPath, liveConfigs), false);
    assert.equal(liveConfigs.size, 0);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: [
          {
            id: "codex-local",
            displayName: "Codex (this project)",
            agentType: "codex",
            command: "codex",
            args: ["exec"],
            workingDirectory: tempDir,
            enabled: true,
          },
        ],
      }),
    );

    assert.equal(refreshAgentConfigs(configPath, liveConfigs), true);
    assert.equal(liveConfigs.get("codex-local")?.displayName, "Codex (this project)");
  });
});

// ---------------------------------------------------------------------------
// Phase 3.5: config hardening.
// ---------------------------------------------------------------------------

describe("loadAgentConfigs: command hardening", () => {
  test("a command containing whitespace is rejected (args belong in args)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "spacey", command: "node scripts/demo-agent.js", workingDirectory: ".", enabled: true },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("a command containing shell metacharacters is rejected", () => {
    const metacharCommands = ["node;rm", "node&&x", "node|x", "node$(x)", "node`x`", "node>out"];
    for (const command of metacharCommands) {
      const { configPath } = writeTempConfig({
        agents: [{ id: "meta", command, workingDirectory: ".", enabled: true }],
      });
      assert.equal(loadAgentConfigs(configPath).size, 0, `expected "${command}" to be rejected`);
    }
  });

  test("an absolute command path is allowed (intentional — pins an exact binary)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "absolute", command: process.execPath, workingDirectory: ".", enabled: true },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 1);
    assert.equal(configs.get("absolute")?.command, process.execPath);
  });
});

describe("loadAgentConfigs: workingDirectory hardening", () => {
  test("a workingDirectory resolving to the filesystem root is rejected", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "rooty", command: "node", workingDirectory: "/", enabled: true }],
    });
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });
});

describe("loadAgentConfigs: maxRuntimeSeconds", () => {
  test("defaults to 3600 (DEFAULT_MAX_RUNTIME_SECONDS) when omitted", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-limit-set", command: "node", workingDirectory: ".", enabled: true }],
    });
    assert.equal(loadAgentConfigs(configPath).get("no-limit-set")?.maxRuntimeSeconds, 3600);
  });

  test("a valid per-entry override is honored", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "short", command: "node", workingDirectory: ".", enabled: true, maxRuntimeSeconds: 30 },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).get("short")?.maxRuntimeSeconds, 30);
  });

  test("non-numeric, non-finite, zero, or negative values reject the entry", () => {
    for (const bad of ["60", -5, 0, null]) {
      const { configPath } = writeTempConfig({
        agents: [
          { id: "bad-limit", command: "node", workingDirectory: ".", enabled: true, maxRuntimeSeconds: bad },
        ],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `expected maxRuntimeSeconds=${JSON.stringify(bad)} to reject the entry`,
      );
    }
  });

  // Regression: a value large enough to overflow setTimeout's 32-bit ms delay
  // (> ~2,147,483 s) would otherwise clamp to a 1ms timer and kill the session
  // almost immediately — the exact inversion of a huge "effectively unlimited"
  // ceiling. It must be rejected at load time, and a value right at the bound
  // must still be accepted.
  test("a value that would overflow setTimeout is rejected", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "overflow", command: "node", workingDirectory: ".", enabled: true, maxRuntimeSeconds: 315_360_000 },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("the maximum allowed value (2,147,483s) is accepted", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "at-max", command: "node", workingDirectory: ".", enabled: true, maxRuntimeSeconds: 2_147_483 },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).get("at-max")?.maxRuntimeSeconds, 2_147_483);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: agentType + envAllowlist.
// ---------------------------------------------------------------------------

describe("loadAgentConfigs: agentType", () => {
  test("defaults to 'custom' when omitted", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-type", command: "node", workingDirectory: ".", enabled: true }],
    });
    assert.equal(loadAgentConfigs(configPath).get("no-type")?.agentType, "custom");
  });

  test("a known agentType (claudeCode) is honored", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "cc", command: "node", workingDirectory: ".", enabled: true, agentType: "claudeCode" },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).get("cc")?.agentType, "claudeCode");
  });

  test("an unknown agentType falls back to 'custom' (entry still loads)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        { id: "weird", command: "node", workingDirectory: ".", enabled: true, agentType: "not-a-real-type" },
      ],
    });
    const configs = loadAgentConfigs(configPath);
    assert.equal(configs.size, 1);
    assert.equal(configs.get("weird")?.agentType, "custom");
  });
});

describe("loadAgentConfigs: envAllowlist", () => {
  test("is undefined when omitted (full-env inheritance)", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-env", command: "node", workingDirectory: ".", enabled: true }],
    });
    assert.equal(loadAgentConfigs(configPath).get("no-env")?.envAllowlist, undefined);
  });

  test("a valid string array is honored", () => {
    const { configPath } = writeTempConfig({
      agents: [
        {
          id: "with-env",
          command: "node",
          workingDirectory: ".",
          enabled: true,
          envAllowlist: ["PATH", "HOME"],
        },
      ],
    });
    assert.deepEqual(loadAgentConfigs(configPath).get("with-env")?.envAllowlist, ["PATH", "HOME"]);
  });

  test("a non-array or non-string-array envAllowlist rejects the entry", () => {
    for (const bad of ["PATH", 5, [1, 2], ["ok", 3]]) {
      const { configPath } = writeTempConfig({
        agents: [
          { id: "bad-env", command: "node", workingDirectory: ".", enabled: true, envAllowlist: bad },
        ],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `expected envAllowlist=${JSON.stringify(bad)} to reject the entry`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4.5: sandbox policy.
// ---------------------------------------------------------------------------

describe("loadAgentConfigs: sandbox policy", () => {
  test("no sandbox block → effectiveMode 'none' (unsandboxed default, entry still loads)", () => {
    const { configPath } = writeTempConfig({
      agents: [{ id: "no-sandbox", command: "node", workingDirectory: ".", enabled: true }],
    });
    const entry = loadAgentConfigs(configPath).get("no-sandbox");
    assert.ok(entry);
    assert.equal(entry.sandbox.effectiveMode, "none");
    assert.equal(entry.sandbox.requestedMode, "none");
    assert.equal(entry.sandbox.required, false);
  });

  test("a valid restricted-process policy loads (supported everywhere)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        {
          id: "rp",
          command: "node",
          workingDirectory: ".",
          enabled: true,
          sandbox: { mode: "restricted-process" },
        },
      ],
    });
    const entry = loadAgentConfigs(configPath).get("rp");
    assert.ok(entry);
    assert.equal(entry.sandbox.effectiveMode, "restricted-process");
    assert.equal(entry.sandbox.supported, true);
  });

  test("an unknown sandbox.mode rejects the entry (never silently downgraded)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        {
          id: "bad-mode",
          command: "node",
          workingDirectory: ".",
          enabled: true,
          sandbox: { mode: "totally-made-up" },
        },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("a non-object sandbox, or non-boolean sandbox flags, reject the entry", () => {
    const bads: unknown[] = [
      [], // array
      "sandbox-exec", // string
      { mode: "none", required: "yes" }, // non-boolean required
      { mode: "none", allowNetwork: 1 }, // non-boolean allowNetwork
      { required: true }, // missing mode
    ];
    for (const bad of bads) {
      const { configPath } = writeTempConfig({
        agents: [{ id: "bad-sb", command: "node", workingDirectory: ".", enabled: true, sandbox: bad }],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `expected sandbox=${JSON.stringify(bad)} to reject the entry`,
      );
    }
  });

  test("a container block without an image is INVALID and rejected regardless of `required` (Phase 5.5)", () => {
    // Before 5.5 `container` was a stub mode and this shape merely resolved
    // "unsupported"; now it is a malformed policy — always dropped, loudly.
    for (const required of [true, false]) {
      const { configPath } = writeTempConfig({
        agents: [
          {
            id: "no-image",
            command: "node",
            workingDirectory: ".",
            enabled: true,
            sandbox: { mode: "container", required },
          },
        ],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `a container policy without an image must be rejected (required: ${required})`,
      );
    }
  });

  test("a confining sandbox rejects an unsafe (system) workingDirectory that would load unsandboxed", () => {
    // Without a sandbox, only the filesystem root is rejected, so "/usr" loads.
    const { configPath: okPath } = writeTempConfig({
      agents: [{ id: "usr-nosb", command: "node", workingDirectory: "/usr", enabled: true }],
    });
    assert.equal(loadAgentConfigs(okPath).get("usr-nosb")?.workingDirectory, "/usr");

    // With a confining sandbox, the same system directory is rejected.
    const { configPath: sbPath } = writeTempConfig({
      agents: [
        {
          id: "usr-sb",
          command: "node",
          workingDirectory: "/usr",
          enabled: true,
          sandbox: { mode: "restricted-process" },
        },
      ],
    });
    assert.equal(loadAgentConfigs(sbPath).size, 0, "a sandboxed agent must not run from a system directory");
  });
});

// ---------------------------------------------------------------------------
// Phase 5.5: container sandbox mode.
// ---------------------------------------------------------------------------

describe("loadAgentConfigs: container sandbox (Phase 5.5)", () => {
  // npm test sets ORBITORY_CONTAINER_ENGINE_PATH to the fake engine, so the
  // engine is "available" here unless a test forces otherwise via
  // ORBITORY_DISABLE_CONTAINER_DETECTION.
  const containerAgent = (sandboxOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    id: "cont",
    command: "fake-agent",
    // Note: writeTempConfig dirs live under os.tmpdir() — this implicitly
    // exercises the temp-project exception of the container mount rules.
    workingDirectory: ".",
    enabled: true,
    sandbox: { mode: "container", required: true, image: "orbitory-fake/image:test", ...sandboxOverrides },
    ...extra,
  });

  test("a valid container policy loads, resolved with the engine executable and defaults", () => {
    const { configPath } = writeTempConfig({ agents: [containerAgent({ memoryLimit: "256m" })] });
    const entry = loadAgentConfigs(configPath).get("cont");
    assert.ok(entry, "valid container entry should load");
    assert.equal(entry.sandbox.effectiveMode, "container");
    assert.equal(entry.sandbox.supported, true);
    assert.ok(entry.sandbox.container);
    assert.equal(entry.sandbox.container.image, "orbitory-fake/image:test");
    assert.equal(entry.sandbox.container.containerWorkspace, "/workspace");
    assert.equal(entry.sandbox.container.pidsLimit, 128);
    assert.equal(entry.sandbox.container.memoryLimit, "256m");
    assert.ok(entry.sandbox.container.engineExecutable.length > 0);
  });

  test("required container mode FAILS CLOSED when no engine is available", () => {
    process.env["ORBITORY_DISABLE_CONTAINER_DETECTION"] = "1";
    try {
      const { configPath } = writeTempConfig({ agents: [containerAgent({ required: true })] });
      assert.equal(loadAgentConfigs(configPath).size, 0, "required + engine unavailable must be dropped");
    } finally {
      delete process.env["ORBITORY_DISABLE_CONTAINER_DETECTION"];
    }
  });

  test("optional container mode downgrades to none (loudly) when no engine is available", () => {
    process.env["ORBITORY_DISABLE_CONTAINER_DETECTION"] = "1";
    try {
      const { configPath } = writeTempConfig({ agents: [containerAgent({ required: false })] });
      const entry = loadAgentConfigs(configPath).get("cont");
      assert.ok(entry, "optional + engine unavailable should downgrade, not reject");
      assert.equal(entry.sandbox.effectiveMode, "none");
      assert.equal(entry.sandbox.requestedMode, "container");
      assert.equal(entry.sandbox.downgraded, true);
    } finally {
      delete process.env["ORBITORY_DISABLE_CONTAINER_DETECTION"];
    }
  });

  test("unknown sandbox keys are rejected — no way to smuggle mounts, volumes, or raw flags", () => {
    for (const strayKey of ["mounts", "volumes", "extraArgs", "enabled", "dockerSocket"]) {
      const { configPath } = writeTempConfig({
        agents: [containerAgent({ [strayKey]: ["/var/run/docker.sock:/var/run/docker.sock"] })],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `expected unknown sandbox key "${strayKey}" to reject the entry`,
      );
    }
  });

  test("container-only keys on a non-container mode are rejected (refuse to guess)", () => {
    const { configPath } = writeTempConfig({
      agents: [
        {
          id: "mixed",
          command: "node",
          workingDirectory: ".",
          enabled: true,
          sandbox: { mode: "restricted-process", image: "alpine" },
        },
      ],
    });
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("a working directory UNDER a system directory cannot be container-mounted (but exact-match modes still load it)", () => {
    // `/usr/bin` exists on macOS + Linux and is UNDER `/usr` (a denied root) but
    // is not itself an exact denylist entry. Container mode's *prefix* rule
    // rejects it (bind-mounting anything under /usr is dangerous); the 4.5
    // exact-match confining modes still load it — the whole point of the
    // stronger container rule.
    const underSystem = "/usr/bin";
    const { configPath: containerPath } = writeTempConfig({
      agents: [containerAgent({}, { workingDirectory: underSystem })],
    });
    assert.equal(
      loadAgentConfigs(containerPath).size,
      0,
      "container mode must refuse to bind-mount a directory under a system root",
    );

    const { configPath: execPath } = writeTempConfig({
      agents: [
        {
          id: "exec-under-sys",
          command: "node",
          workingDirectory: underSystem,
          enabled: true,
          sandbox: { mode: "restricted-process" },
        },
      ],
    });
    assert.equal(
      loadAgentConfigs(execPath).size,
      1,
      "non-mount confining modes keep the 4.5 exact-match rule (contrast case)",
    );
  });

  test("the Docker socket's Linux directory (/run) and /var/run are both denied for container mounts", () => {
    // Direct guard for the reviewed escape: on Linux /var/run -> /run holds
    // /run/docker.sock. These dirs may not exist on the CI host (macOS), so
    // this asserts the denylist MEMBERSHIP via the exact-match path using dirs
    // that do exist here; the symlink test above covers the realpath mechanism.
    for (const dir of ["/private/var/run"]) {
      if (!fs.existsSync(dir)) continue;
      const { configPath } = writeTempConfig({
        agents: [containerAgent({}, { workingDirectory: dir })],
      });
      assert.equal(loadAgentConfigs(configPath).size, 0, `${dir} must be denied for a container mount`);
    }
  });

  test("a working directory whose path contains ':' is rejected for container mode (mount-spec injection)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-colon-"));
    const colonDir = path.join(base, "col:on");
    fs.mkdirSync(colonDir);
    const configPath = path.join(base, "orbitory.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: [containerAgent({}, { workingDirectory: colonDir })] }),
    );
    assert.equal(loadAgentConfigs(configPath).size, 0);
  });

  test("container allowNetwork FAILS SAFE to false when the key is omitted (network denied by default)", () => {
    // Contrast with sandbox-exec, whose allowNetwork defaults to true. For a
    // read-confining container, an omitted key must never silently grant net.
    const { configPath } = writeTempConfig({ agents: [containerAgent()] }); // note: no allowNetwork
    const entry = loadAgentConfigs(configPath).get("cont");
    assert.ok(entry);
    assert.equal(entry.sandbox.allowNetwork, false, "omitted allowNetwork must resolve to false for container mode");

    // Explicit true is still honored.
    const { configPath: onPath } = writeTempConfig({ agents: [containerAgent({ allowNetwork: true })] });
    assert.equal(loadAgentConfigs(onPath).get("cont")?.sandbox.allowNetwork, true);
  });

  test("a container workingDirectory that SYMLINKS into a denied system dir is rejected (mount escape)", () => {
    // Regression for the Linux /var/run -> /run (docker.sock) realpath escape:
    // the resolved path, not the symlink, is what gets denylist-checked. Uses
    // /etc (exists + denied on macOS and Linux) so the test is OS-independent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-symlink-"));
    const link = path.join(dir, "sneaky");
    fs.symlinkSync("/etc", link);
    const configPath = path.join(dir, "orbitory.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: [containerAgent({}, { workingDirectory: link })] }),
    );
    assert.equal(
      loadAgentConfigs(configPath).size,
      0,
      "a symlink resolving into a denied system directory must be rejected for a container mount",
    );
  });

  test("container envAllowlist entries must be plain env names (no '=', no flag-like tokens)", () => {
    for (const bad of [["FOO=bar"], ["-e"], ["ok", "1BAD"]]) {
      const { configPath } = writeTempConfig({
        agents: [containerAgent({}, { envAllowlist: bad })],
      });
      assert.equal(
        loadAgentConfigs(configPath).size,
        0,
        `expected container envAllowlist ${JSON.stringify(bad)} to reject the entry`,
      );
    }
    // The same names are fine on a NON-container entry (unchanged 4.x semantics).
    const { configPath: okPath } = writeTempConfig({
      agents: [
        { id: "plain", command: "node", workingDirectory: ".", enabled: true, envAllowlist: ["FOO=bar"] },
      ],
    });
    assert.equal(loadAgentConfigs(okPath).size, 1);
  });
});
