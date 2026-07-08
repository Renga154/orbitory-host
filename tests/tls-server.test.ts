/**
 * Phase 9 — real HTTPS/WSS integration test.
 *
 * Starts an actual Fastify server over TLS using the committed throwaway fixture
 * cert (tests/fixtures/tls/), then exercises HTTPS `/health`, HTTPS `/sessions`
 * auth (401 without token, 200 with the static test token), and a real WSS
 * handshake. Also confirms the fingerprint a client computes from the presented
 * cert equals the one `computeCertFingerprintSha256` produces (the value the
 * pairing code carries for pinning).
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { buildServer } from "../src/server.js";
import { computeCertFingerprintSha256 } from "../src/tls.js";
import { connect } from "./helpers/wsClient.js";
import type { FastifyInstance } from "fastify";

const CERT = readFileSync(join(process.cwd(), "tests", "fixtures", "tls", "test-cert.pem"));
const KEY = readFileSync(join(process.cwd(), "tests", "fixtures", "tls", "test-key.pem"));
const TOKEN = "orbitory-test-token"; // matches the test-script ORBITORY_PAIRING_TOKEN

let app: FastifyInstance;
let port: number;

before(async () => {
  app = await buildServer({ tls: { cert: CERT, key: KEY } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

after(async () => {
  await app.close();
});

interface HttpsResult {
  status: number;
  body: string;
  fingerprint: string;
}

function httpsGet(path: string, headers: Record<string, string> = {}): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, path, method: "GET", headers, rejectUnauthorized: false },
      (res) => {
        // Capture the presented cert now, while the TLS socket is still attached.
        const der = (res.socket as import("node:tls").TLSSocket).getPeerCertificate(true).raw;
        const fingerprint = createHash("sha256").update(der).digest("hex");
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, fingerprint });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("tls-server: HTTPS", () => {
  test("GET /health works over HTTPS and the presented cert matches the pinned fingerprint", async () => {
    const res = await httpsGet("/health");
    assert.equal(res.status, 200);
    assert.match(res.body, /"status":"ok"/);
    // The fingerprint a client computes from the live cert == the one we advertise.
    assert.equal(res.fingerprint, computeCertFingerprintSha256(CERT));
  });

  test("GET /sessions over HTTPS still requires a valid token", async () => {
    const unauth = await httpsGet("/sessions");
    assert.equal(unauth.status, 401);

    const authed = await httpsGet("/sessions", { Authorization: `Bearer ${TOKEN}` });
    assert.equal(authed.status, 200);

    const badToken = await httpsGet("/sessions", { Authorization: "Bearer wrong-token" });
    assert.equal(badToken.status, 401);
  });
});

describe("tls-server: WSS", () => {
  test("a WSS client authenticates and receives server.hello", async () => {
    const client = connect(`wss://127.0.0.1:${port}/ws?token=${TOKEN}`, { rejectUnauthorized: false });
    await client.waitForOpen();
    const hello = await client.waitFor((e) => e.type === "server.hello");
    assert.equal(hello.type, "server.hello");
    client.close();
  });

  test("a WSS client with a bad token is rejected", async () => {
    const client = connect(`wss://127.0.0.1:${port}/ws?token=nope`, { rejectUnauthorized: false });
    const closed = await client.waitForClose();
    assert.equal(closed.code, 4401);
  });
});

describe("tls-server: fingerprint parity", () => {
  test("computeCertFingerprintSha256 matches a hand-computed DER SHA-256", () => {
    const der = new X509Certificate(CERT).raw;
    const expected = createHash("sha256").update(der).digest("hex");
    assert.equal(computeCertFingerprintSha256(CERT), expected);
  });
});
