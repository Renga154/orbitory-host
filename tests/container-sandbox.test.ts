/**
 * Phase 5.5 — Container Sandbox Mode, end to end through a real server.
 *
 * Every test here runs WITHOUT Docker/Podman: package.json's test script sets
 * `ORBITORY_CONTAINER_ENGINE_PATH=tests/fixtures/fake-container-engine.js`, so
 * the `container-*` entries in tests/fixtures/test-agents.config.json spawn the
 * fake engine — an argv-recording stand-in for the docker/podman client that
 * prints the argv it received (`FAKE_ENGINE_ARGV_JSON: …`) and the `-e` env
 * key names (`CONTAINER_ENV_KEYS: …`, names only), then simulates a CLI.
 *
 * That argv line lets these tests assert the *actual* flags that would reach a
 * real engine — network none, resource limits, cap-drop, the single workspace
 * mount, no docker.sock, no home dir — through the entire session.start →
 * spawn path, not just at the pure-builder layer (tests/sandbox.test.ts).
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import type { HostInfo, AgentSession } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

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

function start(providerId: string, extra: Record<string, unknown> = {}): void {
  const host = hosts[0];
  assert.ok(host, "expected at least one seeded host");
  client.send({
    type: "session.start",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    payload: { hostId: host.id, agentType: "custom", title: "Container test", providerId, ...extra },
  });
}

/** Wait for the fake engine's argv line for `sessionId` and parse it. */
async function receivedArgv(sessionId: string): Promise<string[]> {
  const line = await client.waitFor(
    (e) =>
      e.type === "terminal.output" &&
      e.sessionId === sessionId &&
      (e.payload as { text: string }).text.startsWith("FAKE_ENGINE_ARGV_JSON: "),
    5000,
  );
  const text = (line.payload as { text: string }).text;
  return JSON.parse(text.slice("FAKE_ENGINE_ARGV_JSON: ".length)) as string[];
}

describe("container sandbox: banner + engine argv (end to end)", () => {
  test("the session banner reports container mode with engine, image, and network state", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const banner = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("[orbitory] sandbox:"),
      4000,
    );
    const text = (banner.payload as { text: string }).text;
    assert.match(text, /container/);
    assert.match(text, /docker/);
    assert.match(text, /orbitory-fake\/image:test/);
    assert.match(text, /network denied/);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("the engine receives the exact safety argv: run/--rm/-i, network none, limits, cap-drop, no-new-privileges", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const argv = await receivedArgv(sessionId);

    assert.equal(argv[0], "run");
    for (const flag of ["--rm", "-i", "--read-only"]) {
      assert.ok(argv.includes(flag), `expected ${flag} in ${JSON.stringify(argv)}`);
    }
    const valueOf = (f: string) => argv[argv.indexOf(f) + 1];
    assert.equal(valueOf("--network"), "none");
    assert.equal(valueOf("--memory"), "256m");
    assert.equal(valueOf("--cpus"), "1");
    assert.equal(valueOf("--pids-limit"), "64");
    assert.equal(valueOf("--cap-drop"), "ALL");
    assert.equal(valueOf("--security-opt"), "no-new-privileges");
    assert.equal(valueOf("--workdir"), "/workspace");
    assert.match(valueOf("--name"), /^orbitory-session_\d+$/);

    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("the ONLY mount is the working directory at /workspace — never home, never docker.sock", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const argv = await receivedArgv(sessionId);

    const mounts = argv.filter((_, idx) => argv[idx - 1] === "-v");
    assert.equal(mounts.length, 1, "exactly one -v mount");
    assert.ok(mounts[0]!.endsWith(":/workspace:rw"), `unexpected mount ${mounts[0]}`);
    assert.match(mounts[0]!, /tests\/fixtures:/, "the mount source must be the configured working directory");

    const serialized = JSON.stringify(argv);
    assert.equal(serialized.includes("docker.sock"), false, "docker socket must never be mounted");
    const home = os.homedir();
    assert.equal(
      mounts.some((m) => m === home || m.startsWith(`${home}:`)),
      false,
      "the host home directory must never be the mount source",
    );

    // The command vector after the image is the verbatim host config, inert data.
    const imageIdx = argv.indexOf("orbitory-fake/image:test");
    assert.ok(imageIdx > 0, "image must appear in argv");
    assert.deepEqual(argv.slice(imageIdx + 1), ["fake-agent", "--exit-code=0", "--delay-ms=120"]);

    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("allowNetwork: true omits the network flag — and is the explicit, documented opt-in", async () => {
    start("container-net-allowed");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const argv = await receivedArgv(sessionId);
    assert.equal(argv.includes("--network"), false);
    const banner = client.received.find(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("[orbitory] sandbox:"),
    );
    assert.ok(banner, "expected a sandbox banner");
    assert.match((banner.payload as { text: string }).text, /network ALLOWED/);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("container sandbox: lifecycle through the fake engine", () => {
  test("stdout and stderr stream as terminal.output; exit 0 → session.completed", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const stdout = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === "Container agent (fake) starting up.",
      4000,
    );
    assert.ok(stdout);
    const stderr = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { stream: string }).stream === "stderr",
      4000,
    );
    assert.match((stderr.payload as { text: string }).text, /FAKE container engine/);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });

  test("non-zero container exit → session.failed with the exit code", async () => {
    start("container-fake-fail");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const failed = await client.waitFor((e) => e.type === "session.failed" && e.sessionId === sessionId, 6000);
    assert.match((failed.payload as { reason: { en: string } }).reason.en, /exited with code 2/);
  });

  test("session.stop terminates the container session quickly", async () => {
    // Uses `container-fake-stoppable` (long delay, DEFAULT runtime ceiling) —
    // NOT `container-fake-slow` (maxRuntimeSeconds: 1) — so there is no race
    // between the user stop and the runtime ceiling that could flip the reason.
    start("container-fake-stoppable");
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
    const failed = await client.waitFor((e) => e.type === "session.failed" && e.sessionId === sessionId, 5000);
    assert.ok(Date.now() - startedAt < 4000, "stop should resolve quickly");
    assert.equal((failed.payload as { reason: { en: string } }).reason.en, "Stopped by user.");
  });

  test("maxRuntimeSeconds still applies to a container session", async () => {
    start("container-fake-slow");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const startedAt = Date.now();
    const failed = await client.waitFor((e) => e.type === "session.failed" && e.sessionId === sessionId, 6000);
    assert.ok(Date.now() - startedAt < 5000, "runtime ceiling should fire ~1s");
    assert.match((failed.payload as { reason: { en: string } }).reason.en, /exceeded its maximum runtime/);
  });

  test("chat.message reaches the container process's stdin verbatim (via the engine client), never a shell", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const dangerous = "write a file; rm -rf / && echo pwned `whoami`";
    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId,
      payload: { messageId: "container_msg_1", text: dangerous },
    });
    const echo = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text === `Received prompt: "${dangerous}" (container fake).`,
      4000,
    );
    assert.ok(echo);
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});

describe("container sandbox: scrubbing + env policy still hold", () => {
  test("fake secrets printed inside the container are redacted before reaching any envelope", async () => {
    start("container-fake-secrets");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);

    const rawSecrets = [
      "sk-ant-api03-fakecontainer1234",
      "ghp_fakecontainerfake567890abcdefgh",
      "fake-container-bare-token-99",
      "sk-fakecontainerstderr555555",
    ];
    const sessionEnvelopes = client.received.filter((e) => e.sessionId === sessionId);
    for (const env of sessionEnvelopes) {
      const serialized = JSON.stringify(env);
      for (const secret of rawSecrets) {
        assert.equal(serialized.includes(secret), false, `raw secret "${secret}" leaked in a ${env.type} envelope`);
      }
    }
    assert.ok(
      sessionEnvelopes.some(
        (e) => e.type === "terminal.output" && (e.payload as { text: string }).text.includes("[REDACTED_SECRET]"),
      ),
      "expected at least one redacted line",
    );
  });

  test("envAllowlist forwards ONLY allowlisted keys into the container; the pairing token never", async () => {
    process.env["ORBITORY_CONTAINER_ENV_MARKER"] = "1";
    process.env["ORBITORY_CONTAINER_ENV_BLOCKED"] = "1";
    try {
      start("container-fake-envtest");
      const created = await client.waitFor((e) => e.type === "session.created", 3000);
      const sessionId = created.sessionId!;
      const envLine = await client.waitFor(
        (e) =>
          e.type === "terminal.output" &&
          e.sessionId === sessionId &&
          (e.payload as { text: string }).text.startsWith("CONTAINER_ENV_KEYS:"),
        4000,
      );
      const text = (envLine.payload as { text: string }).text;
      assert.match(text, /ORBITORY_CONTAINER_ENV_MARKER/, "allowlisted key should be forwarded");
      assert.equal(text.includes("ORBITORY_CONTAINER_ENV_BLOCKED"), false, "non-allowlisted key must not be forwarded");
      // This is a MEANINGFUL check: container-fake-envtest DELIBERATELY lists
      // ORBITORY_PAIRING_TOKEN in its envAllowlist, and the token IS set in the
      // host-agent's env (the test pairing token) — so it would be forwarded but
      // for the unconditional strip in containerEnvPassthroughKeys/buildContainerArgv.
      assert.equal(text.includes("ORBITORY_PAIRING_TOKEN"), false, "pairing token must never be forwarded even if allowlisted");
      await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
    } finally {
      delete process.env["ORBITORY_CONTAINER_ENV_MARKER"];
      delete process.env["ORBITORY_CONTAINER_ENV_BLOCKED"];
    }
  });

  test("an OMITTED envAllowlist forwards NOTHING into the container (least-privilege container default)", async () => {
    start("container-fake");
    const created = await client.waitFor((e) => e.type === "session.created", 3000);
    const sessionId = created.sessionId!;
    const envLine = await client.waitFor(
      (e) =>
        e.type === "terminal.output" &&
        e.sessionId === sessionId &&
        (e.payload as { text: string }).text.startsWith("CONTAINER_ENV_KEYS:"),
      4000,
    );
    assert.equal((envLine.payload as { text: string }).text, "CONTAINER_ENV_KEYS: ");
    await client.waitFor((e) => e.type === "session.completed" && e.sessionId === sessionId, 6000);
  });
});
