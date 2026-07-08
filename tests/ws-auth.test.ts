/**
 * Tests for the `/ws` WebSocket authentication handshake, per
 * docs/protocol.md sections 2 and 3: query-param token, first-`client.hello`
 * token, invalid token, and the handshake timeout.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect } from "./helpers/wsClient.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe("WebSocket auth: invalid token", () => {
  test("wrong token via query param -> immediate error envelope + socket close", async () => {
    const client = connect(`${server.wsUrl}/ws?token=totally-wrong-token`);
    await client.waitForOpen();

    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    assert.equal(errorEnvelope.sessionId, null);
    const payload = errorEnvelope.payload as { code: string; message: string; recoverable: boolean };
    assert.equal(payload.code, "unauthorized");
    assert.equal(payload.recoverable, false);
    assert.equal(typeof payload.message, "string");

    const closeInfo = await client.waitForClose();
    assert.equal(closeInfo.code, 4401);
    assert.equal(closeInfo.reason, "unauthorized");
  });
});

describe("WebSocket auth: successful handshake", () => {
  test("correct token via query param -> server.hello then session.snapshot in order", async () => {
    const client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    await client.waitForOpen();

    const hello = await client.waitFor((e) => e.type === "server.hello");
    assert.equal(hello.sessionId, null);
    const helloPayload = hello.payload as {
      serverName: string;
      serverVersion: string;
      protocolVersion: number;
      hostId: string;
      capabilities: string[];
    };
    assert.equal(helloPayload.serverName, "orbitory-host-agent");
    assert.equal(typeof helloPayload.serverVersion, "string");
    assert.equal(helloPayload.protocolVersion, 1);
    assert.equal(typeof helloPayload.hostId, "string");
    assert.ok(Array.isArray(helloPayload.capabilities));

    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    assert.equal(snapshot.sessionId, null);
    const snapshotPayload = snapshot.payload as { hosts: unknown[]; sessions: unknown[] };
    assert.ok(Array.isArray(snapshotPayload.hosts));
    assert.ok(Array.isArray(snapshotPayload.sessions));

    // Confirm ordering: server.hello must have been received strictly before
    // session.snapshot in the raw received buffer.
    const helloIndex = client.received.findIndex((e) => e.type === "server.hello");
    const snapshotIndex = client.received.findIndex((e) => e.type === "session.snapshot");
    assert.ok(helloIndex >= 0 && snapshotIndex >= 0);
    assert.ok(helloIndex < snapshotIndex, "server.hello must arrive before session.snapshot");

    client.close();
    await client.waitForClose();
  });

  test("correct token via first client.hello message (no query param) -> authenticates successfully", async () => {
    const client = connect(`${server.wsUrl}/ws`);
    await client.waitForOpen();

    client.send({
      type: "client.hello",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: { token: PAIRING_TOKEN },
    });

    const hello = await client.waitFor((e) => e.type === "server.hello");
    assert.equal(hello.sessionId, null);

    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    assert.equal(snapshot.sessionId, null);

    client.close();
    await client.waitForClose();
  });
});

describe("WebSocket auth: handshake timeout", () => {
  test("no token and no follow-up client.hello within the timeout -> error + close", async () => {
    const client = connect(`${server.wsUrl}/ws`);
    await client.waitForOpen();
    // Deliberately do not send anything. The server's handshake timeout is
    // HELLO_TIMEOUT_MS (src/config.ts) — 5s in production, shortened via
    // ORBITORY_HELLO_TIMEOUT_MS in package.json's "test" script so this
    // test doesn't have to wait out the full production window. Wait it
    // out with generous margin either way.
    const configuredMs = Number(process.env["ORBITORY_HELLO_TIMEOUT_MS"]) || 5_000;
    const errorEnvelope = await client.waitFor((e) => e.type === "error", configuredMs + 3_000);
    assert.equal(errorEnvelope.sessionId, null);
    const payload = errorEnvelope.payload as { code: string; recoverable: boolean };
    // docs/protocol.md section 7 defines a distinct "handshake_timeout" code
    // for this case (no valid client.hello arrived at all), separate from
    // "unauthorized" (a hello arrived but the token was missing/wrong).
    // src/ws.ts's resolveToken() now distinguishes the two explicitly.
    assert.equal(payload.code, "handshake_timeout");
    assert.equal(payload.recoverable, false);

    const closeInfo = await client.waitForClose();
    assert.equal(closeInfo.code, 4401);
    assert.equal(closeInfo.reason, "unauthorized");
  });
});
