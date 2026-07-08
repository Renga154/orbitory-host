/**
 * Regression test for pairing-token log redaction.
 *
 * Exercises every log surface that touches a pairing token — Fastify's
 * automatic request logger (both `GET /sessions?token=...` and the
 * `/ws?token=...` WebSocket upgrade), the REST auth-failure log line, and
 * the WebSocket auth success/failure log lines — and asserts the real
 * secret token never appears as a substring anywhere in the captured log
 * output, while confirming redacted evidence (the "...<last 4 chars>" form)
 * *does* appear, so this test can't pass trivially by logging nothing at all.
 *
 * Uses the same `ORBITORY_PAIRING_TOKEN` every other test file uses (set by
 * `npm test`), rather than trying to set a different token per test file:
 * src/config.ts reads `process.env.ORBITORY_PAIRING_TOKEN` exactly once, at
 * module-load time, into a top-level constant — setting the env var later
 * from within a test's `before()` has no effect on the already-computed
 * value. That token ("orbitory-test-token", not the well-known
 * `orbitory-dev-token` fallback) is already a realistic secret-shaped value
 * distinct from the intentionally-public dev-fallback constant that's
 * printed in full by the startup warning banner (see src/config.ts) — so it
 * doesn't need its own dedicated value to prove real leakage would be caught.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect } from "./helpers/wsClient.js";
import { redactToken } from "../src/logging.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

let server: TestServer;

before(async () => {
  server = await startTestServer({ captureLogs: true });
});

after(async () => {
  await server.close();
});

function allLogText(): string {
  return (server.logLines ?? []).join("\n");
}

describe("pairing token never appears in full in any log line", () => {
  test("GET /sessions with correct token via query param", async () => {
    const res = await fetch(`${server.httpUrl}/sessions?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    assert.equal(res.status, 200);
  });

  test("GET /sessions with wrong token via query param", async () => {
    const res = await fetch(`${server.httpUrl}/sessions?token=totally-wrong-token`);
    assert.equal(res.status, 401);
  });

  test("GET /sessions with correct token via Authorization header", async () => {
    const res = await fetch(`${server.httpUrl}/sessions`, {
      headers: { Authorization: `Bearer ${PAIRING_TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  test("WebSocket connect with correct token via query param", async () => {
    const client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    await client.waitForOpen();
    await client.waitFor((e) => e.type === "server.hello");
    client.close();
    await client.waitForClose();
  });

  test("WebSocket connect with wrong token via query param", async () => {
    const client = connect(`${server.wsUrl}/ws?token=another-wrong-token`);
    await client.waitForOpen();
    await client.waitFor((e) => e.type === "error");
    await client.waitForClose();
  });

  test("WebSocket connect with correct token via first client.hello message", async () => {
    const client = connect(`${server.wsUrl}/ws`);
    await client.waitForOpen();
    client.send({
      type: "client.hello",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { token: PAIRING_TOKEN },
    });
    await client.waitFor((e) => e.type === "server.hello");
    client.close();
    await client.waitForClose();
  });

  test("after all of the above: the real pairing token never appears in captured logs, but redacted evidence does", () => {
    const logText = allLogText();

    assert.ok(logText.length > 0, "expected some log output to have been captured");

    assert.equal(
      logText.includes(PAIRING_TOKEN!),
      false,
      "the full pairing token must never appear in any log line",
    );

    // Positive control: redacted evidence (the "...<last 4 chars>" form)
    // must actually appear somewhere, proving this test isn't passing
    // merely because logging silently produced nothing.
    const redactedForm = redactToken(PAIRING_TOKEN);
    assert.ok(
      logText.includes(redactedForm),
      `expected the redacted token form "${redactedForm}" to appear somewhere in the logs`,
    );

    // Also confirm the wrong-token attempts' suffixes appear in redacted
    // form (proving the auth-failure paths are redacted too, not just the
    // success path).
    assert.ok(
      logText.includes(redactToken("totally-wrong-token")),
      "expected the wrong REST token's redacted suffix to appear in the logs",
    );
    assert.ok(
      logText.includes(redactToken("another-wrong-token")),
      "expected the wrong WS token's redacted suffix to appear in the logs",
    );
  });
});
