/**
 * Phase 8 — per-device pairing-token store tests.
 *
 * Security-critical assertions: raw tokens are NEVER persisted (only SHA-256
 * hashes), and verify() rejects unknown / expired / revoked tokens. Plus
 * load-through file persistence (a token issued by one store instance verifies
 * from another reading the same file — the CLI ↔ server case).
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  FilePersistence,
  MemoryPersistence,
  PairedDeviceStore,
  hashToken,
} from "../src/pairedDevices.js";

/** A store with a controllable clock and deterministic id/token generators. */
function makeStore(persistence = new MemoryPersistence()) {
  let clock = new Date("2026-07-04T00:00:00.000Z");
  let idN = 0;
  let tokN = 0;
  const store = new PairedDeviceStore({
    persistence,
    now: () => clock,
    generateId: () => `dev_${++idN}`,
    generateToken: () => `raw-token-${++tokN}`,
    deviceTtlSeconds: 30 * 24 * 60 * 60,
  });
  return {
    store,
    persistence,
    setClock: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

describe("paired-devices: issue", () => {
  test("returns a raw token + a public record with no tokenHash, and sets expiry from ttl", () => {
    const { store } = makeStore();
    const { record, rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    assert.equal(rawToken, "raw-token-1");
    assert.equal(record.id, "dev_1");
    assert.equal(record.deviceName, "iPhone");
    assert.equal(record.createdAt, "2026-07-04T00:00:00.000Z");
    assert.equal(record.expiresAt, "2026-07-04T00:10:00.000Z");
    assert.equal(record.revokedAt, null);
    assert.equal(record.lastUsedAt, null);
    assert.equal("tokenHash" in record, false, "public record must not expose the tokenHash");
  });

  test("ttl <= 0 disables expiry (expiresAt null)", () => {
    const { store } = makeStore();
    const { record } = store.issue({ deviceName: "dev", ttlSeconds: 0 });
    assert.equal(record.expiresAt, null);
  });

  test("blank device name falls back to a placeholder", () => {
    const { store } = makeStore();
    const { record } = store.issue({ deviceName: "   ", ttlSeconds: 60 });
    assert.equal(record.deviceName, "Unnamed device");
  });
});

describe("paired-devices: the raw token is never persisted", () => {
  test("persisted data holds only the SHA-256 hash, never the raw token", () => {
    const { store, persistence } = makeStore();
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    const data = persistence.load();
    assert.equal(data.devices.length, 1);
    assert.equal(data.devices[0].tokenHash, hashToken(rawToken));
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes(rawToken), false, "the raw token must never appear in the store");
  });
});

describe("paired-devices: verify", () => {
  test("promotes a short-lived pairing credential to a sliding device credential on first use", () => {
    const { store, setClock } = makeStore();
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });

    setClock("2026-07-04T00:05:00.000Z");
    const activated = store.verify(rawToken, "ios-profile-1");
    assert.equal(activated.ok, true);
    if (activated.ok) {
      assert.equal(activated.record.activatedAt, "2026-07-04T00:05:00.000Z");
      assert.equal(activated.record.expiresAt, "2026-08-03T00:05:00.000Z");
    }

    setClock("2026-07-20T12:00:00.000Z");
    const refreshed = store.verify(rawToken, "ios-profile-1");
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) {
      assert.equal(refreshed.record.expiresAt, "2026-08-19T12:00:00.000Z");
    }
  });

  test("binds an activated credential to the first saved client profile", () => {
    const { store } = makeStore();
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });

    assert.equal(store.verify(rawToken, "ios-profile-1").ok, true);
    assert.deepEqual(store.verify(rawToken, "ios-profile-2"), {
      ok: false,
      reason: "device_mismatch",
    });
    assert.deepEqual(store.verify(rawToken), { ok: false, reason: "device_mismatch" });
  });

  test("accepts the raw token and stamps lastUsedAt", () => {
    const { store, setClock } = makeStore();
    const { rawToken, record } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    setClock("2026-07-04T00:05:00.000Z");
    const result = store.verify(rawToken);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.id, record.id);
      assert.equal(result.record.lastUsedAt, "2026-07-04T00:05:00.000Z");
    }
  });

  test("rejects a missing/empty token", () => {
    const { store } = makeStore();
    assert.deepEqual(store.verify(undefined), { ok: false, reason: "missing" });
    assert.deepEqual(store.verify(""), { ok: false, reason: "missing" });
  });

  test("rejects an unknown token", () => {
    const { store } = makeStore();
    store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    assert.deepEqual(store.verify("some-other-token"), { ok: false, reason: "unknown" });
  });

  test("rejects an expired token", () => {
    const { store, setClock } = makeStore();
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    setClock("2026-07-04T00:10:01.000Z");
    assert.deepEqual(store.verify(rawToken), { ok: false, reason: "expired" });
  });

  test("a token with expiry disabled never expires", () => {
    const { store, setClock } = makeStore();
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 0 });
    setClock("2099-01-01T00:00:00.000Z");
    assert.equal(store.verify(rawToken).ok, true);
  });

  test("rejects a revoked token", () => {
    const { store } = makeStore();
    const { rawToken, record } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    assert.equal(store.revoke(record.id), true);
    assert.deepEqual(store.verify(rawToken), { ok: false, reason: "revoked" });
  });

  test("fails safe: a corrupt/unparseable expiresAt is treated as expired, not never-expiring", () => {
    // Simulate a tampered/partially-written store record: valid tokenHash, garbage expiresAt.
    const raw = "tampered-raw-token";
    const persistence = new MemoryPersistence({
      version: 1,
      devices: [
        {
          id: "dev_x",
          deviceName: "iPhone",
          tokenHash: hashToken(raw),
          createdAt: "2026-07-04T00:00:00.000Z",
          lastUsedAt: null,
          expiresAt: "never", // unparseable — Date.parse(...) is NaN
          revokedAt: null,
        },
      ],
    });
    const store = new PairedDeviceStore({
      persistence,
      now: () => new Date("2026-07-04T00:00:01.000Z"),
    });
    assert.deepEqual(
      store.verify(raw),
      { ok: false, reason: "expired" },
      "a non-null but unparseable expiresAt must deny (fail safe), never authenticate forever",
    );
  });
});

describe("paired-devices: revoke + list", () => {
  test("revoke is idempotent-ish: true once, then false", () => {
    const { store } = makeStore();
    const { record } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    assert.equal(store.revoke(record.id), true);
    assert.equal(store.revoke(record.id), false, "already revoked");
    assert.equal(store.revoke("dev_nonexistent"), false, "unknown id");
  });

  test("list returns public records only (no tokenHash)", () => {
    const { store } = makeStore();
    store.issue({ deviceName: "A", ttlSeconds: 600 });
    store.issue({ deviceName: "B", ttlSeconds: 600 });
    const listed = store.list();
    assert.equal(listed.length, 2);
    for (const r of listed) {
      assert.equal("tokenHash" in r, false, "list must not expose token hashes");
    }
    assert.deepEqual(
      listed.map((r) => r.deviceName),
      ["A", "B"],
    );
  });
});

describe("paired-devices: file persistence is load-through (CLI ↔ server)", () => {
  const path = join(tmpdir(), `orbitory-paired-devices-${randomBytes(6).toString("hex")}.json`);
  afterEach(() => {
    if (existsSync(path)) rmSync(path);
  });

  test("a token issued via one store instance verifies from another reading the same file", () => {
    const issuer = new PairedDeviceStore({ persistence: new FilePersistence(path) });
    const { rawToken } = issuer.issue({ deviceName: "iPhone", ttlSeconds: 600 });

    // A separate instance (simulating the server process) reads the same file.
    const verifier = new PairedDeviceStore({ persistence: new FilePersistence(path) });
    assert.equal(verifier.verify(rawToken).ok, true);
    assert.deepEqual(verifier.verify("nope"), { ok: false, reason: "unknown" });
  });

  test("a corrupt store file loads as empty rather than throwing", () => {
    const badPath = join(tmpdir(), `orbitory-bad-${randomBytes(6).toString("hex")}.json`);
    const fp = new FilePersistence(badPath);
    fp.save({ version: 1, devices: [] });
    // Corrupt it.
    writeFileSync(badPath, "{ not json");
    const data = fp.load();
    assert.deepEqual(data.devices, []);
    rmSync(badPath);
  });
});
