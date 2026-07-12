/**
 * Phase 4.5 — sandbox policy model + macOS enforcement primitive.
 *
 * Two layers:
 *  1. Pure resolution/profile/wrapping logic (no process): supported vs.
 *     unsupported modes, fail-closed (`required`) vs. downgrade, profile
 *     contents, and how a command is wrapped for each effective mode.
 *  2. The real macOS `sandbox-exec` boundary: spawn a plain `node` under a
 *     generated profile and prove it can write INSIDE the working directory but
 *     NOT outside it, and that network is denied. Guarded by
 *     `sandboxExecAvailable()` so it self-skips where the OS can't enforce it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildContainerArgv,
  buildSandboxExecProfile,
  agentStateWritablePaths,
  defaultResolvedSandbox,
  describeSandbox,
  isSandboxModeSupported,
  resolveSandboxPolicy,
  sandboxExecAvailable,
  validateContainerConfig,
  wrapCommandForSandbox,
  type ContainerSandboxConfig,
  type SandboxPolicy,
} from "../src/sandbox.js";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "sandbox-exec",
    required: false,
    allowNetwork: true,
    allowedWorkingDirectoryOnly: true,
    ...overrides,
  };
}

/** A fully-defaulted container config for unit tests (Phase 5.5). */
function containerCfg(overrides: Partial<ContainerSandboxConfig> = {}): ContainerSandboxConfig {
  return {
    engine: "docker",
    image: "orbitory-fake/image:test",
    containerWorkspace: "/workspace",
    workspaceMountReadonly: false,
    pidsLimit: 128,
    readOnlyRootFilesystem: true,
    dropCapabilities: true,
    noNewPrivileges: true,
    ...overrides,
  };
}

describe("sandbox: isSandboxModeSupported", () => {
  test("none and restricted-process are always supported", () => {
    assert.equal(isSandboxModeSupported("none"), true);
    assert.equal(isSandboxModeSupported("restricted-process"), true);
  });

  test("container support follows engine availability (Phase 5.5)", () => {
    assert.equal(
      isSandboxModeSupported("container", { containerEngineOverride: "/fake/docker" }),
      true,
    );
    assert.equal(isSandboxModeSupported("container", { containerEngineOverride: null }), false);
  });

  test("sandbox-exec follows the availability override", () => {
    assert.equal(isSandboxModeSupported("sandbox-exec", { sandboxExecOverride: true }), true);
    assert.equal(isSandboxModeSupported("sandbox-exec", { sandboxExecOverride: false }), false);
  });
});

describe("sandbox: defaultResolvedSandbox", () => {
  test("is an unsandboxed, non-required, supported policy", () => {
    const d = defaultResolvedSandbox();
    assert.equal(d.effectiveMode, "none");
    assert.equal(d.requestedMode, "none");
    assert.equal(d.required, false);
    assert.equal(d.supported, true);
    assert.equal(d.mustReject, false);
    assert.equal(d.downgraded, false);
  });
});

describe("sandbox: resolveSandboxPolicy", () => {
  test("a supported mode is used as-is (no downgrade, no reject)", () => {
    const r = resolveSandboxPolicy(policy({ mode: "sandbox-exec" }), { sandboxExecOverride: true });
    assert.equal(r.effectiveMode, "sandbox-exec");
    assert.equal(r.supported, true);
    assert.equal(r.downgraded, false);
    assert.equal(r.mustReject, false);
  });

  test("restricted-process resolves to itself everywhere", () => {
    const r = resolveSandboxPolicy(policy({ mode: "restricted-process", required: true }));
    assert.equal(r.effectiveMode, "restricted-process");
    assert.equal(r.mustReject, false);
  });

  test("unsupported + required → mustReject (fail closed), effectiveMode none", () => {
    const r = resolveSandboxPolicy(policy({ mode: "sandbox-exec", required: true }), {
      sandboxExecOverride: false,
    });
    assert.equal(r.supported, false);
    assert.equal(r.effectiveMode, "none");
    assert.equal(r.mustReject, true);
    assert.equal(r.downgraded, true);
  });

  test("unsupported + not required → downgraded to none, not rejected", () => {
    const r = resolveSandboxPolicy(policy({ mode: "sandbox-exec", required: false }), {
      sandboxExecOverride: false,
    });
    assert.equal(r.effectiveMode, "none");
    assert.equal(r.mustReject, false);
    assert.equal(r.downgraded, true);
  });

  test("container without an available engine: required → reject, optional → downgrade", () => {
    const withContainer = policy({ mode: "container", container: containerCfg() });
    assert.equal(
      resolveSandboxPolicy({ ...withContainer, required: true }, { containerEngineOverride: null }).mustReject,
      true,
    );
    const optional = resolveSandboxPolicy(
      { ...withContainer, required: false },
      { containerEngineOverride: null },
    );
    assert.equal(optional.mustReject, false);
    assert.equal(optional.effectiveMode, "none");
    assert.equal(optional.downgraded, true);
  });

  test("container with an available engine resolves to container and carries the executable", () => {
    const r = resolveSandboxPolicy(policy({ mode: "container", container: containerCfg() }), {
      containerEngineOverride: "/opt/fake/docker",
    });
    assert.equal(r.effectiveMode, "container");
    assert.equal(r.supported, true);
    assert.equal(r.mustReject, false);
    assert.ok(r.container);
    assert.equal(r.container.engineExecutable, "/opt/fake/docker");
    assert.equal(r.container.image, "orbitory-fake/image:test");
  });

  test("container mode without container settings fails closed (invariant guard)", () => {
    const r = resolveSandboxPolicy(policy({ mode: "container", required: true }), {
      containerEngineOverride: "/opt/fake/docker",
    });
    assert.equal(r.mustReject, true);
    assert.equal(r.effectiveMode, "none");
  });
});

describe("sandbox: buildSandboxExecProfile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-profile-"));
  const realDir = fs.realpathSync(dir);

  test("confines writes to the working dir realpath and denies network when asked", () => {
    const profile = buildSandboxExecProfile(dir, {
      allowNetwork: false,
      allowedWorkingDirectoryOnly: true,
    });
    assert.match(profile, /^\(version 1\)/);
    assert.match(profile, /\(allow default\)/);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.ok(profile.includes(`(subpath "${realDir}")`), "profile must allow writes under the realpath");
    assert.match(profile, /\(deny network\*\)/);
  });

  test("omits the network deny when network is allowed, and write-confine when disabled", () => {
    const netOk = buildSandboxExecProfile(dir, { allowNetwork: true, allowedWorkingDirectoryOnly: true });
    assert.equal(/\(deny network\*\)/.test(netOk), false);

    const noConfine = buildSandboxExecProfile(dir, { allowNetwork: true, allowedWorkingDirectoryOnly: false });
    assert.equal(/\(deny file-write\*\)/.test(noConfine), false);
  });

  test("allows only explicitly supplied CLI state paths in addition to the workspace", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-agent-state-"));
    const profile = buildSandboxExecProfile(dir, {
      allowNetwork: true,
      allowedWorkingDirectoryOnly: true,
      additionalWritablePaths: [stateDir],
    });

    assert.ok(profile.includes(`(subpath "${fs.realpathSync(stateDir)}")`));
    assert.equal(profile.includes(`(subpath "${path.dirname(fs.realpathSync(stateDir))}")`), false);
  });
});

describe("sandbox: agentStateWritablePaths", () => {
  test("opens only the selected CLI's own state files", () => {
    assert.deepEqual(agentStateWritablePaths("codex", "/Users/tester"), [
      "/Users/tester/.codex",
    ]);
    assert.deepEqual(agentStateWritablePaths("claudeCode", "/Users/tester"), [
      "/Users/tester/.claude",
      "/Users/tester/.claude.json",
    ]);
    assert.deepEqual(agentStateWritablePaths("custom", "/Users/tester"), []);
  });
});

describe("sandbox: wrapCommandForSandbox", () => {
  const cwd = process.cwd();

  test("none runs the command as-is, not detached", () => {
    const w = wrapCommandForSandbox("node", ["x.js"], defaultResolvedSandbox(), cwd);
    assert.equal(w.command, "node");
    assert.deepEqual(w.args, ["x.js"]);
    assert.equal(w.detached, false);
  });

  test("restricted-process runs as-is but detached (own process group)", () => {
    const sb = resolveSandboxPolicy(policy({ mode: "restricted-process" }));
    const w = wrapCommandForSandbox("node", ["x.js"], sb, cwd);
    assert.equal(w.command, "node");
    assert.equal(w.detached, true);
  });

  test("sandbox-exec wraps in /usr/bin/sandbox-exec -p <profile> …, detached", () => {
    const sb = resolveSandboxPolicy(policy({ mode: "sandbox-exec" }), { sandboxExecOverride: true });
    const w = wrapCommandForSandbox("node", ["x.js"], sb, cwd);
    assert.equal(w.command, "/usr/bin/sandbox-exec");
    assert.equal(w.args[0], "-p");
    assert.match(w.args[1] ?? "", /\(version 1\)/);
    assert.equal(w.args[2], "node");
    assert.equal(w.args[3], "x.js");
    assert.equal(w.detached, true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5.5: container config validation + argv builder (pure, no process).
// ---------------------------------------------------------------------------

describe("sandbox: validateContainerConfig", () => {
  const validRaw = { mode: "container", image: "node:22-alpine" };

  test("a minimal valid config gets safe defaults", () => {
    const r = validateContainerConfig(validRaw, "test");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.config.engine, "docker");
      assert.equal(r.config.containerWorkspace, "/workspace");
      assert.equal(r.config.workspaceMountReadonly, false);
      assert.equal(r.config.pidsLimit, 128);
      assert.equal(r.config.readOnlyRootFilesystem, true);
      assert.equal(r.config.dropCapabilities, true);
      assert.equal(r.config.noNewPrivileges, true);
    }
  });

  test("missing image is rejected", () => {
    assert.equal(validateContainerConfig({ mode: "container" }, "test").ok, false);
  });

  test("unsafe image strings are rejected (flags, metacharacters, whitespace, uppercase repo)", () => {
    for (const image of [
      "-rm", // would parse as an engine flag
      "--privileged",
      "img; rm -rf /",
      "img with spaces",
      "img$(x)",
      "img`x`",
      "IMG:latest", // uppercase repo
      "",
    ]) {
      assert.equal(
        validateContainerConfig({ mode: "container", image }, "test").ok,
        false,
        `expected image ${JSON.stringify(image)} to be rejected`,
      );
    }
  });

  test("valid image forms are accepted (repo, tag, digest)", () => {
    for (const image of [
      "alpine",
      "node:22-alpine",
      "orbitory-local/claude-code:latest",
      "ghcr.io/acme/tool:1.2.3",
      `alpine@sha256:${"a".repeat(64)}`,
    ]) {
      assert.equal(
        validateContainerConfig({ mode: "container", image }, "test").ok,
        true,
        `expected image ${JSON.stringify(image)} to be accepted`,
      );
    }
  });

  test("unsafe containerWorkspace values are rejected", () => {
    for (const containerWorkspace of ["relative/path", "/", "/a/../b", "/work:space", "/work space", "/work,space"]) {
      assert.equal(
        validateContainerConfig({ mode: "container", image: "alpine", containerWorkspace }, "test").ok,
        false,
        `expected containerWorkspace ${JSON.stringify(containerWorkspace)} to be rejected`,
      );
    }
  });

  test("malformed memory/cpu/pids/user/engine values are rejected", () => {
    const bads: Array<Record<string, unknown>> = [
      { memoryLimit: "lots" },
      { memoryLimit: "512x" },
      { memoryLimit: 512 },
      { cpuLimit: "two" },
      { cpuLimit: "0" },
      { cpuLimit: -1 },
      { pidsLimit: 0 },
      { pidsLimit: 1.5 },
      { pidsLimit: "128" },
      { user: "user name" },
      { user: "-u" },
      { engine: "containerd" },
      { engine: "docker; rm" },
      { workspaceMount: "readwrite-ish" },
      { readOnlyRootFilesystem: "yes" },
    ];
    for (const bad of bads) {
      assert.equal(
        validateContainerConfig({ mode: "container", image: "alpine", ...bad }, "test").ok,
        false,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });
});

describe("sandbox: buildContainerArgv", () => {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-cargv-")));

  function build(overrides: Partial<Parameters<typeof buildContainerArgv>[0]> = {}) {
    return buildContainerArgv({
      container: { ...containerCfg(), engineExecutable: "/opt/fake/docker" },
      allowNetwork: false,
      workingDirectory: workDir,
      command: "fake-agent",
      args: ["--exit-code=0"],
      envPassthroughKeys: ["PATH", "MY_KEY"],
      containerName: "orbitory-session_0001",
      ...overrides,
    });
  }

  test("produces an argv array for the engine executable — never a shell string", () => {
    const launch = build();
    assert.equal(launch.executable, "/opt/fake/docker");
    assert.ok(Array.isArray(launch.args));
    assert.equal(launch.args[0], "run");
    // No element is a shell-joined composite of the command.
    assert.equal(launch.args.some((a) => a.includes("fake-agent --exit-code")), false);
  });

  test("includes the safety flags: --rm, -i, network none, pids, read-only+tmpfs, cap-drop, no-new-privileges", () => {
    const a = build().args;
    for (const flag of ["--rm", "-i", "--read-only"]) {
      assert.ok(a.includes(flag), `expected ${flag}`);
    }
    const pair = (f: string) => a[a.indexOf(f) + 1];
    assert.equal(pair("--network"), "none");
    assert.equal(pair("--pids-limit"), "128");
    assert.equal(pair("--tmpfs"), "/tmp");
    assert.equal(pair("--cap-drop"), "ALL");
    assert.equal(pair("--security-opt"), "no-new-privileges");
    assert.equal(pair("--workdir"), "/workspace");
    assert.equal(pair("--name"), "orbitory-session_0001");
  });

  test("the ONLY volume mount is workingDirectory:/workspace, rw by default, ro when configured", () => {
    const a = build().args;
    const mounts = a.filter((_, idx) => a[idx - 1] === "-v");
    assert.equal(mounts.length, 1, "exactly one -v mount");
    assert.equal(mounts[0], `${workDir}:/workspace:rw`);

    const ro = build({
      container: { ...containerCfg({ workspaceMountReadonly: true }), engineExecutable: "/opt/fake/docker" },
    }).args;
    const roMounts = ro.filter((_, idx) => ro[idx - 1] === "-v");
    assert.equal(roMounts[0], `${workDir}:/workspace:ro`);
  });

  test("resource flags appear only when configured; network flag disappears when allowed", () => {
    const withLimits = build({
      container: {
        ...containerCfg({ memoryLimit: "512m", cpuLimit: "1.5" }),
        engineExecutable: "/opt/fake/docker",
      },
    }).args;
    assert.equal(withLimits[withLimits.indexOf("--memory") + 1], "512m");
    assert.equal(withLimits[withLimits.indexOf("--cpus") + 1], "1.5");

    const noLimits = build().args;
    assert.equal(noLimits.includes("--memory"), false);
    assert.equal(noLimits.includes("--cpus"), false);

    const netAllowed = build({ allowNetwork: true }).args;
    assert.equal(netAllowed.includes("--network"), false);
  });

  test("env passthrough is key-only -e (values NEVER in argv); bad keys and the pairing token are dropped", () => {
    const a = build({
      envPassthroughKeys: ["PATH", "ORBITORY_PAIRING_TOKEN", "FOO=bar", "-e", "OK_KEY"],
    }).args;
    const envArgs = a.filter((_, idx) => a[idx - 1] === "-e");
    assert.deepEqual(envArgs, ["PATH", "OK_KEY"]);
    // No -e value may contain '=' — a KEY=value form would SET a value (and
    // put it in argv/`ps`) instead of forwarding it from the client env.
    for (const key of envArgs) {
      assert.equal(key.includes("="), false);
    }
  });

  test("everything after the image is the verbatim command vector", () => {
    const a = build().args;
    const imageIdx = a.indexOf("orbitory-fake/image:test");
    assert.ok(imageIdx > 0);
    assert.deepEqual(a.slice(imageIdx + 1), ["fake-agent", "--exit-code=0"]);
  });

  test("an invalid container name falls back to a safe constant", () => {
    const a = build({ containerName: "; rm -rf /" }).args;
    assert.equal(a[a.indexOf("--name") + 1], "orbitory-session");
  });
});

describe("sandbox: wrapCommandForSandbox (container)", () => {
  test("container mode wraps via buildContainerArgv, detached", () => {
    const resolved = resolveSandboxPolicy(policy({ mode: "container", container: containerCfg() }), {
      containerEngineOverride: "/opt/fake/docker",
    });
    const w = wrapCommandForSandbox("fake-agent", ["--x"], resolved, process.cwd(), {
      envPassthroughKeys: [],
      containerName: "orbitory-session_0002",
    });
    assert.equal(w.command, "/opt/fake/docker");
    assert.equal(w.args[0], "run");
    assert.equal(w.detached, true);
  });

  test("container mode without container settings throws (programming-error path, never runs unconfined)", () => {
    const broken = {
      ...resolveSandboxPolicy(policy({ mode: "container", container: containerCfg() }), {
        containerEngineOverride: "/opt/fake/docker",
      }),
      container: undefined,
    };
    assert.throws(() =>
      wrapCommandForSandbox("fake-agent", [], broken, process.cwd(), {
        envPassthroughKeys: [],
        containerName: "x",
      }),
    );
  });
});

describe("sandbox: describeSandbox", () => {
  test("is blunt about none NOT being a boundary", () => {
    assert.match(describeSandbox(defaultResolvedSandbox()), /unsandboxed/);
  });

  test("container banner names engine, image, workspace, and network state", () => {
    const resolved = resolveSandboxPolicy(
      policy({ mode: "container", allowNetwork: false, container: containerCfg({ memoryLimit: "256m" }) }),
      { containerEngineOverride: "/opt/fake/docker" },
    );
    const line = describeSandbox(resolved);
    assert.match(line, /container/);
    assert.match(line, /docker/);
    assert.match(line, /orbitory-fake\/image:test/);
    assert.match(line, /network denied/);
    assert.match(line, /mem 256m/);
  });
  test("names sandbox-exec confinement + network state", () => {
    const sb = resolveSandboxPolicy(policy({ mode: "sandbox-exec", allowNetwork: false }), {
      sandboxExecOverride: true,
    });
    const line = describeSandbox(sb);
    assert.match(line, /sandbox-exec/);
    assert.match(line, /network denied/);
  });
});

// ---------------------------------------------------------------------------
// The real macOS boundary. Self-skips where sandbox-exec can't enforce.
// ---------------------------------------------------------------------------

describe("sandbox: macOS sandbox-exec actually confines writes + network", () => {
  const available = sandboxExecAvailable();

  test("a process can write inside its working dir but not outside it, and network is denied", (t) => {
    if (!available) {
      t.skip("sandbox-exec unavailable on this host (not macOS or binary missing)");
      return;
    }

    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-sbenf-")));
    // The "outside" target must be a location NOT allow-listed by the profile.
    // The profile allows the working dir plus the system temp roots, so the
    // outside target is deliberately in the home directory (writable when
    // unsandboxed, so a pass genuinely proves the sandbox is what denies it).
    const outsideFile = path.join(os.homedir(), `.orbitory-sbtest-outside-${process.pid}.txt`);
    try {
      const profile = buildSandboxExecProfile(workDir, {
        allowNetwork: false,
        allowedWorkingDirectoryOnly: true,
      });
      const script = `
        const fs = require("fs"), path = require("path");
        try { fs.writeFileSync(path.join(process.cwd(), "inside.txt"), "x"); console.log("INSIDE ok"); }
        catch (e) { console.log("INSIDE denied " + e.code); }
        try { fs.writeFileSync(${JSON.stringify(outsideFile)}, "x"); console.log("OUTSIDE ok"); }
        catch (e) { console.log("OUTSIDE denied " + e.code); }
        try {
          const s = require("net").connect(80, "1.1.1.1");
          s.on("error", (e) => { console.log("NET denied " + e.code); process.exit(0); });
          s.on("connect", () => { console.log("NET ok"); s.destroy(); process.exit(0); });
          setTimeout(() => { console.log("NET timeout"); process.exit(0); }, 1500);
        } catch (e) { console.log("NET threw " + e.code); }
      `;
      const res = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", script], {
        cwd: workDir,
        encoding: "utf8",
        timeout: 8000,
      });
      const out = `${res.stdout}\n${res.stderr}`;
      assert.match(out, /INSIDE ok/, `expected inside write to succeed; got:\n${out}`);
      assert.match(out, /OUTSIDE denied/, `expected outside write to be denied; got:\n${out}`);
      // The outside file must not exist on disk either.
      assert.equal(fs.existsSync(outsideFile), false);
      // Network must be denied (sandbox EPERM), not connected/refused.
      assert.match(out, /NET denied/, `expected network to be denied; got:\n${out}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });
});
