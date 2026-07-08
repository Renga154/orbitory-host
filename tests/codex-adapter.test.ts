/**
 * Phase 5 — Codex Adapter Alpha tests.
 *
 * The deliberate twin of `claude-code-adapter.test.ts`. These drive the *fake*
 * Codex CLI (`scripts/fake-codex.js`, via the `codex-*` entries in
 * `tests/fixtures/test-agents.config.json`) — never the real Codex, which is
 * neither required nor invoked for CI. They verify the whole adapter path: a
 * codex-typed session starts, is labeled `codex` host-authoritatively, streams
 * stdout/stderr, receives chat via stdin (never a shell), redacts secrets,
 * completes/fails per exit code, stops safely, respects the runtime ceiling,
 * honors the `envAllowlist` policy, still scrubs under a sandbox, and rejects
 * disabled/unconfigured providers.
 *
 * The fake CLI emits NO `[[STATUS]]` markers, so this exercises exactly the
 * generic terminal lifecycle a real Codex session would produce.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import { presetCopy, presetLabel, CODEX_EXAMPLE_CONFIG } from "../src/providers/agentPresets.js";
import { sandboxExecAvailable } from "../src/sandbox.js";
import type { HostInfo, AgentSession } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

// ---------------------------------------------------------------------------
// Pure preset tests (no server, no process).
// ---------------------------------------------------------------------------

describe("agentPresets: codex", () => {
  test("codex gets branded 'Codex' copy", () => {
    assert.equal(presetLabel("codex", "Some Display Name"), "Codex");
    const copy = presetCopy("codex", "Some Display Name");
    assert.match(copy.starting.en, /Codex/);
    assert.match(copy.running.en, /Codex is working/);
    assert.match(copy.completed.en, /Codex finished/);
    assert.match(copy.running.ja, /Codex/);
  });

  test("the Codex example config is disabled by default, typed, and requires its sandbox", () => {
    assert.equal(CODEX_EXAMPLE_CONFIG.enabled, false);
    assert.equal(CODEX_EXAMPLE_CONFIG.agentType, "codex");
    assert.equal(CODEX_EXAMPLE_CONFIG.command, "codex");
    assert.deepEqual(CODEX_EXAMPLE_CONFIG.args, ["exec"]);
    // Phase 5.5: the example moved to container mode, network still off.
    assert.equal(CODEX_EXAMPLE_CONFIG.sandbox.mode, "container");
    assert.equal(CODEX_EXAMPLE_CONFIG.sandbox.required, true);
    assert.equal(CODEX_EXAMPLE_CONFIG.sandbox.allowNetwork, false);
  });

  test("orbitory.config.example.json's codex-disposable entry stays in sync and is disabled", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const examplePath = path.resolve(here, "../orbitory.config.example.json");
    const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    const entry = example.agents.find((a) => a["id"] === CODEX_EXAMPLE_CONFIG.id);
    assert.ok(entry, "example config must contain the codex-disposable entry");
    assert.equal(entry["enabled"], false, "the example Codex entry MUST ship disabled");
    assert.equal(entry["agentType"], "codex");
    assert.equal(entry["command"], CODEX_EXAMPLE_CONFIG.command);
    assert.deepEqual(entry["args"], CODEX_EXAMPLE_CONFIG.args);
    assert.deepEqual(
      entry["sandbox"],
      CODEX_EXAMPLE_CONFIG.sandbox,
      "example sandbox block must match CODEX_EXAMPLE_CONFIG",
    );
    assert.equal((entry["sandbox"] as { required: boolean }).required, true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real server, fake Codex process.
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
    payload: { hostId: host.id, agentType: "custom", title: "Codex test", providerId, ...extra },
  });
}

describe("Codex adapter: allowlist enforcement", () => {
  test("a disabled codex entry cannot be started", async () => {
    start("codex-disabled");
    const next = await client.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
    assert.equal((next.payload as { code: string }).code, "invalid_payload");
  });

  test("an unconfigured providerId cannot be started", async () => {
    start("codex-does-not-exist");
    const next = await client.waitFor((e) => e.type === "error" || e.type === "session.created", 3000);
    assert.equal(next.type, "error");
  });
});

describe("Codex adapter: session is host-authoritatively labeled codex", () => {
  test("session.created reports agentType codex even though the client sent custom", async () => {
    start("codex-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const payload = created.payload as { agentType: string; status: string };
    assert.equal(payload.agentType, "codex");
    assert.equal(payload.status, "planning");
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === created.sessionId, 6000);
  });

  test("the branded 'Codex' status copy is used, not the raw display name", async () => {
    start("codex-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const statusChange = await client.waitFor(
      (e) => e.type === "agent.status.changed" && e.sessionId === sessionId,
      3000,
    );
    const summary = (statusChange.payload as { currentSummary: { en: string } }).currentSummary;
    assert.match(summary.en, /Codex/);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("Codex adapter: streaming, lifecycle, stop", () => {
  test("stdout and stderr both stream as terminal.output; exit 0 → session.completed", async () => {
    start("codex-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const stdout = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { stream: string }).stream === "stdout" &&
        (e.payload as { text: string }).text.startsWith("Codex (fake)"),
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
    assert.match((stderr.payload as { text: string }).text, /FAKE Codex/);

    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("non-zero exit → session.failed with the exit code in the reason", async () => {
    start("codex-fake-fail");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const failed = await client.waitFor(
      (e) => e.type === "session.failed" && e.sessionId === sessionId,
      6000,
    );
    assert.match((failed.payload as { reason: { en: string } }).reason.en, /exited with code 2/);
  });

  test("session.stop terminates a running fake Codex quickly", async () => {
    start("codex-fake-slow");
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

  test("a fake Codex exceeding maxRuntimeSeconds is killed with a runtime reason", async () => {
    start("codex-fake-slow");
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

describe("Codex adapter: chat.message goes to stdin, never a shell", () => {
  test("a shell-metacharacter message is echoed back verbatim by the fake CLI", async () => {
    start("codex-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;

    const dangerous = "make a README; rm -rf / && echo pwned `whoami`";
    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "codex_msg_1", text: dangerous },
    });

    const echo = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === `Received prompt: "${dangerous}". Working on it (fake codex).`,
      4000,
    );
    assert.ok(echo);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("session.start's initialPrompt is delivered to the fake CLI's stdin", async () => {
    start("codex-fake", { initialPrompt: "Create a disposable README." });
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const echo = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === 'Received prompt: "Create a disposable README.". Working on it (fake codex).',
      4000,
    );
    assert.ok(echo);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("Codex adapter: output secret scrubbing", () => {
  test("no fake secret printed by the fake Codex reaches any client envelope", async () => {
    start("codex-fake-secrets");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);

    const rawSecrets = [
      "sk-fakecodexfake1234567890abcd",
      "ghp_fakecodexfake1234567890abcdefgh",
      "fake-codex-bare-token-77",
      "sk-fakecodexstderr0987654321",
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

describe("Codex adapter: runs under a sandbox policy (Phase 4.5 preserved)", () => {
  test("a sandboxed fake Codex completes, shows the sandbox banner, and still scrubs secrets", async () => {
    start("codex-fake-sandboxed");
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

    const rawSecrets = [
      "sk-fakecodexfake1234567890abcd",
      "ghp_fakecodexfake1234567890abcdefgh",
      "fake-codex-bare-token-77",
      "sk-fakecodexstderr0987654321",
    ];
    const sessionEnvelopes = client.received.filter((e) => e.sessionId === sessionId);
    for (const env of sessionEnvelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(serialized.includes(secret), false, `raw secret "${secret}" leaked from a sandboxed codex session`);
      }
    }
    assert.ok(
      sessionEnvelopes.some(
        (e) => e.type === "terminal.output" && (e.payload as { text: string }).text.includes("[REDACTED_SECRET]"),
      ),
      "expected at least one redacted line from the sandboxed codex session",
    );
  });
});

describe("Codex adapter: envAllowlist policy", () => {
  test("the child receives only allowlisted env keys, not other host-agent env vars", async () => {
    process.env["ORBITORY_CODEX_ENV_MARKER"] = "1";
    process.env["ORBITORY_CODEX_ENV_BLOCKED"] = "1";
    try {
      start("codex-envtest");
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
      assert.match(text, /ORBITORY_CODEX_ENV_MARKER/, "allowlisted key should be present");
      assert.equal(text.includes("ORBITORY_CODEX_ENV_BLOCKED"), false, "non-allowlisted key must be absent");
      assert.equal(text.includes("ORBITORY_PAIRING_TOKEN"), false, "pairing token must never be passed to the child");
      await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
    } finally {
      delete process.env["ORBITORY_CODEX_ENV_MARKER"];
      delete process.env["ORBITORY_CODEX_ENV_BLOCKED"];
    }
  });
});
