/**
 * Phase 4 — Claude Code Adapter Alpha tests.
 *
 * These drive the *fake* Claude Code CLI (`scripts/fake-claude-code.js`, via
 * the `claude-code-*` entries in `tests/fixtures/test-agents.config.json`) —
 * never the real Claude Code, which is neither installed nor required for
 * CI. They verify the whole adapter path: a claudeCode-typed session starts,
 * is labeled `claudeCode` host-authoritatively, streams stdout/stderr,
 * receives chat via stdin (never a shell), redacts secrets, completes/fails
 * per exit code, stops safely, respects the runtime ceiling, honors the
 * `envAllowlist` policy, and rejects disabled/unconfigured providers.
 *
 * The fake CLI emits NO `[[STATUS]]` markers, so this exercises exactly the
 * generic terminal lifecycle a real Claude Code session would produce.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { presetCopy, presetLabel, CLAUDE_CODE_EXAMPLE_CONFIG } from "../src/providers/agentPresets.js";
import { sandboxExecAvailable } from "../src/sandbox.js";
import type { HostInfo, AgentSession } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

// ---------------------------------------------------------------------------
// Pure preset tests (no server, no process).
// ---------------------------------------------------------------------------

describe("agentPresets", () => {
  test("claudeCode gets branded 'Claude Code' copy", () => {
    assert.equal(presetLabel("claudeCode", "Some Display Name"), "Claude Code");
    const copy = presetCopy("claudeCode", "Some Display Name");
    assert.match(copy.starting.en, /Claude Code/);
    assert.match(copy.running.en, /Claude Code is working/);
    assert.match(copy.completed.en, /Claude Code finished/);
    assert.match(copy.running.ja, /Claude Code/);
  });

  test("custom falls back to the display name (unchanged demo behavior)", () => {
    assert.equal(presetLabel("custom", "Demo Terminal Agent"), "Demo Terminal Agent");
    const copy = presetCopy("custom", "Demo Terminal Agent");
    assert.equal(copy.running.en, "Demo Terminal Agent is running.");
    assert.equal(copy.completed.en, "Demo Terminal Agent finished successfully.");
  });

  test("the Claude Code example config is disabled by default, typed, and requires its sandbox", () => {
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.enabled, false);
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.agentType, "claudeCode");
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.command, "claude");
    // Phase 4.5: it must fail closed if the host can't enforce the sandbox.
    // Phase 5.5: the example moved to container mode (read confinement +
    // resource limits — what a real CLI actually needs), network still off.
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.sandbox.mode, "container");
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.sandbox.required, true);
    assert.equal(CLAUDE_CODE_EXAMPLE_CONFIG.sandbox.allowNetwork, false);
  });

  test("orbitory.config.example.json's claude-code-disposable entry stays in sync and is disabled", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const examplePath = path.resolve(here, "../orbitory.config.example.json");
    const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    const entry = example.agents.find((a) => a["id"] === CLAUDE_CODE_EXAMPLE_CONFIG.id);
    assert.ok(entry, "example config must contain the claude-code-disposable entry");
    assert.equal(entry["enabled"], false, "the example Claude Code entry MUST ship disabled");
    assert.equal(entry["agentType"], "claudeCode");
    assert.equal(entry["command"], CLAUDE_CODE_EXAMPLE_CONFIG.command);
    // The example file's sandbox block must match the canonical constant, and
    // must be a required sandbox (fail closed) — a regression here would ship an
    // example that runs a real CLI unconfined.
    assert.deepEqual(
      entry["sandbox"],
      CLAUDE_CODE_EXAMPLE_CONFIG.sandbox,
      "example sandbox block must match CLAUDE_CODE_EXAMPLE_CONFIG",
    );
    assert.equal((entry["sandbox"] as { required: boolean }).required, true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real server, fake Claude Code process.
// ---------------------------------------------------------------------------

let server: TestServer;
let client: TestWsClient;
let hosts: HostInfo[];

before(async () => {
  server = await startTestServer();
  client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await client.waitForOpen();
  await client.waitFor((e) => e.type === "server.hello");
  const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
  hosts = (snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] }).hosts;
});

after(async () => {
  client.close();
  await server.close();
});

function start(providerId: string | undefined, extra: Record<string, unknown> = {}): void {
  const host = hosts[0];
  assert.ok(host, "expected at least one seeded host");
  client.send({
    type: "session.start",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    // Deliberately send agentType "custom" from the client to prove the host
    // overrides it from config for terminal-backed sessions.
    payload: { hostId: host.id, agentType: "custom", title: "Claude Code test", providerId, ...extra },
  });
}

describe("Claude Code adapter: allowlist enforcement", () => {
  test("a disabled claude-code entry cannot be started", async () => {
    start("claude-code-disabled");
    const next = await client.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
    assert.equal((next.payload as { code: string }).code, "invalid_payload");
  });

  test("an unconfigured providerId cannot be started", async () => {
    start("claude-code-does-not-exist");
    const next = await client.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
  });
});

describe("Claude Code adapter: session is host-authoritatively labeled claudeCode", () => {
  test("session.created reports agentType claudeCode even though the client sent custom", async () => {
    start("claude-code-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const payload = created.payload as { agentType: string; status: string };
    assert.equal(payload.agentType, "claudeCode");
    assert.equal(payload.status, "planning");
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === created.sessionId, 6000);
  });

  test("the branded 'Claude Code' status copy is used, not the raw display name", async () => {
    start("claude-code-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const statusChange = await client.waitFor(
      (e) => e.type === "agent.status.changed" && e.sessionId === sessionId,
      3000,
    );
    const summary = (statusChange.payload as { currentSummary: { en: string } }).currentSummary;
    assert.match(summary.en, /Claude Code/);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("Claude Code adapter: streaming, lifecycle, stop", () => {
  test("stdout and stderr both stream as terminal.output; exit 0 → session.completed", async () => {
    start("claude-code-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const stdout = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { stream: string }).stream === "stdout",
      4000,
    );
    const stderr = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { stream: string }).stream === "stderr",
      4000,
    );
    assert.ok((stdout.payload as { text: string }).text.length > 0);
    assert.match((stderr.payload as { text: string }).text, /FAKE Claude Code/);

    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("non-zero exit → session.failed with the exit code in the reason", async () => {
    start("claude-code-fake-fail");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      6000,
    );
    assert.match((failed.payload as { reason: { en: string } }).reason.en, /exited with code 2/);
  });

  test("session.stop terminates a running fake Claude Code quickly", async () => {
    // claude-code-fake-slow would run ~15s; stop must resolve well before that.
    start("claude-code-fake-slow");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const startedAt = Date.now();
    client.send({
      type: "session.stop",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { reason: "user_requested" },
    });
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      5000,
    );
    assert.ok(Date.now() - startedAt < 4000, "stop should resolve quickly");
    assert.equal((failed.payload as { reason: { en: string } }).reason.en, "Stopped by user.");
  });

  test("a fake Claude Code exceeding maxRuntimeSeconds is killed with a runtime reason", async () => {
    // claude-code-fake-slow has maxRuntimeSeconds: 1 while the process would run ~15s.
    // (Started fresh so the timer measures from this spawn.)
    start("claude-code-fake-slow");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const startedAt = Date.now();
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      6000,
    );
    assert.ok(Date.now() - startedAt < 5000, "runtime ceiling should fire ~1s");
    assert.match((failed.payload as { reason: { en: string } }).reason.en, /exceeded its maximum runtime/);
  });
});

describe("Claude Code adapter: chat.message goes to stdin, never a shell", () => {
  test("a shell-metacharacter message is echoed back verbatim by the fake CLI", async () => {
    start("claude-code-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const dangerous = "make a README; rm -rf / && echo pwned `whoami`";
    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "cc_msg_1", text: dangerous },
    });

    const echo = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === `Received prompt: "${dangerous}". Working on it (fake).`,
      4000,
    );
    assert.ok(echo);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("session.start's initialPrompt is delivered to the fake CLI's stdin", async () => {
    start("claude-code-fake", { initialPrompt: "Create a disposable README." });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const echo = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === 'Received prompt: "Create a disposable README.". Working on it (fake).',
      4000,
    );
    assert.ok(echo);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("Claude Code adapter: output secret scrubbing", () => {
  test("no fake secret printed by the fake Claude Code reaches any client envelope", async () => {
    start("claude-code-fake-secrets");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);

    const rawSecrets = [
      "sk-ant-api03-fakeclaudefake1234",
      "ghp_fakeclaudefake1234567890abcdefgh",
      "fake-claude-bare-token-42",
      "sk-fakeclaudestderr1234567890",
    ];
    const sessionEnvelopes = client.received.filter((e) => e.sessionId === sessionId);
    for (const env of sessionEnvelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(serialized.includes(secret), false, `raw secret "${secret}" leaked in a ${env.type} envelope`);
      }
    }
    const redacted = sessionEnvelopes.some(
      (e) => e.type === "terminal.output" && (e.payload as { text: string }).text.includes("[REDACTED_SECRET]"),
    );
    assert.ok(redacted, "expected at least one redacted line");
  });
});

describe("Claude Code adapter: runs under a sandbox policy (Phase 4.5)", () => {
  test("a sandboxed fake Claude Code completes, shows the sandbox banner, and still scrubs secrets", async () => {
    start("claude-code-fake-sandboxed");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const banner = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("[orbitory] sandbox:"),
      4000,
    );
    if (sandboxExecAvailable()) {
      assert.match((banner.payload as { text: string }).text, /sandbox-exec/);
    }

    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);

    // Scrubbing must still hold on the sandboxed path — the sandbox is an
    // execution boundary, NOT a replacement for output scrubbing.
    const rawSecrets = [
      "sk-ant-api03-fakeclaudefake1234",
      "ghp_fakeclaudefake1234567890abcdefgh",
      "fake-claude-bare-token-42",
      "sk-fakeclaudestderr1234567890",
    ];
    const sessionEnvelopes = client.received.filter((e) => e.sessionId === sessionId);
    for (const env of sessionEnvelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(serialized.includes(secret), false, `raw secret "${secret}" leaked from a sandboxed session`);
      }
    }
    assert.ok(
      sessionEnvelopes.some(
        (e) => e.type === "terminal.output" && (e.payload as { text: string }).text.includes("[REDACTED_SECRET]"),
      ),
      "expected at least one redacted line from the sandboxed session",
    );
  });
});

describe("Claude Code adapter: envAllowlist policy", () => {
  test("the child receives only allowlisted env keys, not other host-agent env vars", async () => {
    // Set one marker that IS allowlisted (claude-code-envtest allows
    // ORBITORY_ENV_ALLOWED_MARKER) and one that is NOT.
    process.env["ORBITORY_ENV_ALLOWED_MARKER"] = "1";
    process.env["ORBITORY_ENV_BLOCKED_MARKER"] = "1";
    try {
      start("claude-code-envtest");
      const created = await client.waitFor((e) => e.type === "session.created", 3000);
      const sessionId = created.sessionId!;
      const envLine = await client.waitFor(
        (e) =>
          e.type === "terminal.output" &&
          e.sessionId === sessionId &&
          (e.payload as { text: string }).text.startsWith("ENV_KEYS:"),
        4000,
      );
      const text = (envLine.payload as { text: string }).text;
      assert.match(text, /ORBITORY_ENV_ALLOWED_MARKER/, "allowlisted key should be present");
      assert.equal(text.includes("ORBITORY_ENV_BLOCKED_MARKER"), false, "non-allowlisted key must be absent");
      // The pairing token env var is never passed even if the host-agent has it.
      assert.equal(text.includes("ORBITORY_PAIRING_TOKEN"), false, "pairing token must never be passed to the child");
      await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
    } finally {
      delete process.env["ORBITORY_ENV_ALLOWED_MARKER"];
      delete process.env["ORBITORY_ENV_BLOCKED_MARKER"];
    }
  });
});

describe("envAllowlist unit behavior: empty array is fail-closed (present ≠ inherit)", () => {
  // Import lazily to keep this near the behavior it documents. `buildChildEnv`
  // is private, so this asserts the contract through the config layer + the
  // documented semantics rather than reaching into the provider: an empty
  // allowlist is a *present* allowlist, so the loader keeps it (it doesn't
  // collapse to undefined), which is what makes the provider pass nothing.
  test("an empty envAllowlist is preserved as an empty array, not dropped to undefined", async () => {
    const { loadAgentConfigs } = await import("../src/agentConfig.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-envempty-"));
    const cfg = path.join(dir, "orbitory.config.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        agents: [
          { id: "empty-env", command: "node", workingDirectory: ".", enabled: true, envAllowlist: [] },
        ],
      }),
    );
    const entry = loadAgentConfigs(cfg).get("empty-env");
    assert.ok(entry);
    assert.deepEqual(entry.envAllowlist, [], "empty allowlist must survive as [] (present, fail-closed)");
    assert.notEqual(entry.envAllowlist, undefined);
  });
});
