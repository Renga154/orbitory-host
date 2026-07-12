/**
 * Tests for the plain HTTP routes (`GET /health`, `GET /sessions`).
 *
 * `GET /sessions` requires the pairing token per docs/protocol.md section 1;
 * `GET /health` does not. See the security fix in `src/http.ts`.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { setPairedDeviceStoreForTests } from "../src/auth.js";
import { MemoryPersistence, PairedDeviceStore } from "../src/pairedDevices.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// The npm "test" script sets ORBITORY_PAIRING_TOKEN=orbitory-test-token
// before invoking the test runner; src/config.ts reads it once at import
// time. Read it back the same way so this test file doesn't hardcode a
// value that could drift from what's actually configured.
const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(
  PAIRING_TOKEN,
  "ORBITORY_PAIRING_TOKEN must be set in the environment for tests to run (see package.json's \"test\" script).",
);

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe("GET /health", () => {
  test("returns 200 with a well-formed body and requires no token", async () => {
    const res = await fetch(`${server.httpUrl}/health`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      status: string;
      uptimeSeconds: number;
      sessionCount: number;
    };

    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.ok(body.uptimeSeconds >= 0, "uptimeSeconds should be >= 0");
    assert.equal(typeof body.sessionCount, "number");
    assert.ok(Number.isInteger(body.sessionCount));
    assert.ok(body.sessionCount >= 0, "sessionCount should be >= 0");
  });
});

describe("GET /sessions", () => {
  test("without a token -> 401 with a simple error body", async () => {
    const res = await fetch(`${server.httpUrl}/sessions`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "unauthorized" });
  });

  test("with the wrong token (query param) -> 401", async () => {
    const res = await fetch(`${server.httpUrl}/sessions?token=definitely-wrong`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "unauthorized" });
  });

  test("with the wrong token (Authorization header) -> 401", async () => {
    const res = await fetch(`${server.httpUrl}/sessions`, {
      headers: { Authorization: "Bearer definitely-wrong" },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "unauthorized" });
  });

  test("with the correct token via query param -> 200 with well-formed sessions", async () => {
    const res = await fetch(`${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: unknown[] };
    assertWellFormedSessionsResponse(body);
  });

  test("with the correct token via Authorization: Bearer header -> 200 with well-formed sessions", async () => {
    const res = await fetch(`${server.httpUrl}/sessions`, {
      headers: { Authorization: `Bearer ${PAIRING_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: unknown[] };
    assertWellFormedSessionsResponse(body);
  });

  test("a saved device credential requires its matching stable client id", async () => {
    const store = new PairedDeviceStore({
      persistence: new MemoryPersistence(),
      deviceTtlSeconds: 30 * 24 * 60 * 60,
    });
    setPairedDeviceStoreForTests(store);
    const { rawToken } = store.issue({ deviceName: "Test iPhone", ttlSeconds: 600 });
    assert.equal(store.verify(rawToken, "profile-test-1").ok, true);

    const missingClientId = await fetch(`${server.httpUrl}/sessions`, {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    assert.equal(missingClientId.status, 401);

    const wrongClientId = await fetch(`${server.httpUrl}/sessions`, {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        "X-Orbitory-Client-Id": "profile-test-2",
      },
    });
    assert.equal(wrongClientId.status, 401);

    const matchingClientId = await fetch(`${server.httpUrl}/sessions`, {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        "X-Orbitory-Client-Id": "profile-test-1",
      },
    });
    assert.equal(matchingClientId.status, 200);
  });
});

function assertWellFormedSessionsResponse(body: { sessions: unknown[] }): void {
  assert.ok(Array.isArray(body.sessions));
  assert.ok(body.sessions.length > 0, "expected at least one seeded session");

  for (const raw of body.sessions) {
    const session = raw as Record<string, unknown>;
    assert.equal(typeof session["id"], "string");
    assert.equal(typeof session["hostId"], "string");
    assert.equal(typeof session["status"], "string");
    assert.ok(session["currentSummary"] && typeof session["currentSummary"] === "object");
    const currentSummary = session["currentSummary"] as Record<string, unknown>;
    assert.equal(typeof currentSummary["en"], "string");
    assert.equal(typeof currentSummary["ja"], "string");
    assert.ok(session["testStatus"] && typeof session["testStatus"] === "object");
    assert.ok(Array.isArray(session["changedFiles"]));
  }
}
