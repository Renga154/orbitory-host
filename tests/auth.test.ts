/**
 * Phase 8 — `verifyPresentedToken` unit tests.
 *
 * Runs with the test env's static token (`ORBITORY_PAIRING_TOKEN=orbitory-test-token`,
 * so the static fallback is enabled). Injects a controllable per-device store via
 * the test seam. Node's test runner isolates each file in its own process, so the
 * module-store swap here does not leak into other suites.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { MemoryPersistence, PairedDeviceStore } from "../src/pairedDevices.js";
import { setPairedDeviceStoreForTests, verifyPresentedToken } from "../src/auth.js";

describe("auth: verifyPresentedToken", () => {
  let clock = new Date("2026-07-04T00:00:00.000Z");
  let store: PairedDeviceStore;

  beforeEach(() => {
    clock = new Date("2026-07-04T00:00:00.000Z");
    store = new PairedDeviceStore({ persistence: new MemoryPersistence(), now: () => clock });
    setPairedDeviceStoreForTests(store);
  });

  test("accepts a valid per-device token", () => {
    const { rawToken, record } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    const r = verifyPresentedToken(rawToken);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, "device");
      assert.equal(r.record.id, record.id);
    }
  });

  test("accepts the static dev token (documented compatibility fallback)", () => {
    const r = verifyPresentedToken("orbitory-test-token");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.kind, "static");
  });

  test("rejects an unknown token", () => {
    assert.deepEqual(verifyPresentedToken("bogus-token"), { ok: false, reason: "unknown" });
  });

  test("rejects a missing/empty token", () => {
    assert.deepEqual(verifyPresentedToken(undefined), { ok: false, reason: "missing" });
    assert.deepEqual(verifyPresentedToken(""), { ok: false, reason: "missing" });
  });

  test("rejects an expired per-device token and does NOT fall through to static", () => {
    const { rawToken } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    clock = new Date("2026-07-04T01:00:00.000Z");
    assert.deepEqual(verifyPresentedToken(rawToken), { ok: false, reason: "expired" });
  });

  test("rejects a revoked per-device token", () => {
    const { rawToken, record } = store.issue({ deviceName: "iPhone", ttlSeconds: 600 });
    store.revoke(record.id);
    assert.deepEqual(verifyPresentedToken(rawToken), { ok: false, reason: "revoked" });
  });
});
