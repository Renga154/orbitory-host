/**
 * Pairing-token verification (Phase 8).
 *
 * Single place both transports (`ws.ts`, `http.ts`) verify a presented pairing
 * token. Accepts EITHER:
 *   1. a valid per-device token (see `pairedDevices.ts`) — hashed at rest,
 *      expiring, revocable; the preferred model, OR
 *   2. the static `ORBITORY_PAIRING_TOKEN` — a documented lower-security
 *      dev-compatibility fallback that never expires (disable with
 *      `ORBITORY_DISABLE_STATIC_TOKEN=true`).
 *
 * Auth is strictly *added to* here, never loosened: a token that would have been
 * accepted before (the static token) is still accepted unless explicitly disabled.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { PAIRED_DEVICES_PATH, PAIRING_TOKEN, STATIC_TOKEN_ENABLED } from "./config.js";
import {
  FilePersistence,
  PairedDeviceStore,
  type PublicDeviceRecord,
  type VerifyFailureReason,
} from "./pairedDevices.js";

export type AuthResult =
  | { ok: true; kind: "device"; record: PublicDeviceRecord }
  | { ok: true; kind: "static" }
  | { ok: false; reason: VerifyFailureReason };

/**
 * Module-level store singleton, file-backed by default. Tests swap it via
 * `setPairedDeviceStoreForTests`. `verifyPresentedToken` reads it on each call,
 * so a swap takes effect immediately.
 */
let pairedDeviceStore = new PairedDeviceStore({
  persistence: new FilePersistence(PAIRED_DEVICES_PATH),
});

export function getPairedDeviceStore(): PairedDeviceStore {
  return pairedDeviceStore;
}

/** Test seam: replace the module store (e.g. with a MemoryPersistence-backed one). */
export function setPairedDeviceStoreForTests(store: PairedDeviceStore): void {
  pairedDeviceStore = store;
}

/**
 * Constant-time string compare via fixed-length SHA-256 digests, so neither the
 * token length nor an early-mismatch position leaks through timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify a presented pairing token. Per-device tokens are checked first; a token
 * that matched a device record but is expired/revoked is rejected as such (it can
 * never equal the static token, so there is nothing to fall through to). An
 * unknown/absent token then falls back to the static dev token when enabled.
 */
export function verifyPresentedToken(token: string | undefined | null): AuthResult {
  const device = pairedDeviceStore.verify(token);
  if (device.ok) {
    return { ok: true, kind: "device", record: device.record };
  }
  if (device.reason === "expired" || device.reason === "revoked") {
    return { ok: false, reason: device.reason };
  }
  // device.reason is "missing" or "unknown": try the static dev-compat token.
  if (
    STATIC_TOKEN_ENABLED &&
    typeof token === "string" &&
    token.length > 0 &&
    constantTimeEqual(token, PAIRING_TOKEN)
  ) {
    return { ok: true, kind: "static" };
  }
  return { ok: false, reason: device.reason };
}
