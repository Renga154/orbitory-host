/**
 * Phase 16 — de-faked seeding tests.
 *
 * `sessionStore` is a module singleton created at import time and the whole
 * suite runs with `ORBITORY_DEMO_SESSIONS=true` (package.json), so the
 * seed-OFF shape cannot be observed in-process. Following the repo's
 * established pattern for env-sensitive whole-process behavior
 * (tests/pairing.test.ts boots `src/index.ts` as a subprocess), each case
 * here boots a REAL host-agent with a controlled environment, connects a
 * real WebSocket client, and asserts the `session.snapshot` shape.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import { join } from "node:path";

import { connect } from "./helpers/wsClient.js";
import type { AgentSession, HostInfo } from "../src/types.js";

const BOOT_TOKEN = "demo-seed-test-token";

interface BootedServer {
  child: ChildProcess;
  port: number;
  stop(): void;
}

/**
 * Boot `src/index.ts` (via tsx, like pairing.test.ts) with a controlled env.
 * `demoSessions` === undefined removes the variable entirely (the parent test
 * process HAS it set to "true", so plain inheritance would poison the case).
 */
async function bootServer(demoSessions: string | undefined): Promise<BootedServer> {
  const port = 4700 + Math.floor(Math.random() * 400);
  const devicesPath = join(os.tmpdir(), `orbitory-demo-seed-${randomBytes(6).toString("hex")}.json`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORBITORY_PAIRING_TOKEN: BOOT_TOKEN,
    ORBITORY_PAIRED_DEVICES_PATH: devicesPath,
    ORBITORY_AUDIT_LOG_PATH: "/dev/null",
    ORBITORY_AGENT_CONFIG_PATH: "tests/fixtures/test-agents.config.json",
    PORT: String(port),
  };
  delete env["ORBITORY_DEMO_SESSIONS"];
  if (demoSessions !== undefined) {
    env["ORBITORY_DEMO_SESSIONS"] = demoSessions;
  }

  const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });

  const stop = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  // Poll /health until the server is up (or give up loudly).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        return { child, port, stop };
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  stop();
  throw new Error(`host-agent subprocess did not become healthy on port ${port}`);
}

/** Connect, take the snapshot, return {hosts, sessions} plus the client for reuse. */
async function snapshotOf(port: number) {
  const client = connect(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(BOOT_TOKEN)}`);
  await client.waitForOpen();
  await client.waitFor((e) => e.type === "server.hello", 5000);
  const snapshot = await client.waitFor((e) => e.type === "session.snapshot", 5000);
  const payload = snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] };
  return { client, payload };
}

describe("seeding without ORBITORY_DEMO_SESSIONS (the honest default)", () => {
  test("exactly one real local host (os.hostname()), zero sessions; mock start works on it", async () => {
    const server = await bootServer(undefined);
    try {
      const { client, payload } = await snapshotOf(server.port);
      try {
        assert.equal(payload.hosts.length, 1, "exactly one host expected");
        const host = payload.hosts[0]!;
        assert.equal(host.id, os.hostname());
        assert.equal(host.name, os.hostname());
        assert.equal(host.status, "online");
        assert.equal(host.activeSessionCount, 0);
        assert.equal(host.approvalWaitingCount, 0);
        if (process.platform === "darwin") {
          assert.equal(host.type, "mac");
        } else if (process.platform === "linux") {
          assert.equal(host.type, "linux");
        }
        assert.equal(payload.sessions.length, 0, "no seeded sessions expected");

        // A providerId-less session.start against the real host still works
        // (mock provider, honestly marked simulated).
        client.send({
          type: "session.start",
          version: 1,
          timestamp: new Date().toISOString(),
          sessionId: null,
          payload: { hostId: host.id, agentType: "claudeCode", title: "Seed-off mock session" },
        });
        const created = await client.waitFor((e) => e.type === "session.created", 5000);
        const createdPayload = created.payload as { hostId: string; sessionKind?: string; status: string };
        assert.equal(createdPayload.hostId, host.id);
        assert.equal(createdPayload.sessionKind, "simulated");
        assert.equal(createdPayload.status, "planning");
      } finally {
        client.close();
      }
    } finally {
      server.stop();
    }
  });
});

describe("seeding with ORBITORY_DEMO_SESSIONS=false (explicit off)", () => {
  test("same honest shape as unset", async () => {
    const server = await bootServer("false");
    try {
      const { client, payload } = await snapshotOf(server.port);
      client.close();
      assert.equal(payload.hosts.length, 1);
      assert.equal(payload.hosts[0]!.id, os.hostname());
      assert.equal(payload.sessions.length, 0);
    } finally {
      server.stop();
    }
  });
});

describe("seeding with ORBITORY_DEMO_SESSIONS=true (demo/screenshot mode)", () => {
  test("the real host PLUS the 3 fake demo hosts and 4 simulated sessions", async () => {
    const server = await bootServer("true");
    try {
      const { client, payload } = await snapshotOf(server.port);
      client.close();
      assert.equal(payload.hosts.length, 4, "real host + 3 demo hosts expected");
      assert.ok(payload.hosts.some((h) => h.id === os.hostname()), "the real host row must still exist");
      assert.ok(payload.hosts.some((h) => h.id === "host_mac_studio"), "demo hosts must be seeded");
      assert.equal(payload.sessions.length, 4, "the 4 demo sessions must be seeded");
      for (const session of payload.sessions) {
        assert.equal(session.sessionKind, "simulated", "every demo session is honestly marked simulated");
      }
    } finally {
      server.stop();
    }
  });
});
