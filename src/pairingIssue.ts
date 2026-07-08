/**
 * Pairing-code issuance orchestration (Phase 8).
 *
 * Ties the pure pairing-URL builder (`pairing.ts`) to the per-device token store
 * (`pairedDevices.ts` via `auth.ts`): issue a fresh per-device token (hashed at
 * rest, with a server-side `expiresAt`), then embed the raw token + that same
 * expiry in the `orbitory://pair?payload=…` code. Shared by the startup print
 * (`index.ts`) and the `pairing:print` CLI so both mint fresh, expiring codes.
 */

import { getPairedDeviceStore } from "./auth.js";
import { PAIRING_TTL_SECONDS, PORT } from "./config.js";
import { buildPairingPayload, encodePairingURL, resolveAdvertisedHost } from "./pairing.js";
import type { PairedDeviceStore } from "./pairedDevices.js";

export interface IssuedPairingCode {
  url: string;
  deviceId: string;
  deviceName: string;
  expiresAt: string | null;
  host: string;
  isLoopbackFallback: boolean;
  /** True when the code advertises TLS/WSS (secure transport) — Phase 9. */
  secure: boolean;
}

/** Phase 9 secure-transport info to embed in the issued code. */
export interface SecureTransportInfo {
  fingerprintSha256: string;
  subject: string;
  certExpiresAt: string | null;
  httpsPort: number;
  /** TLS hostname override; defaults to the resolved advertised host. */
  hostname?: string;
}

/**
 * Issue a per-device pairing token and format its QR-friendly pairing code. The
 * raw token exists only inside the returned `url`; it is never persisted or
 * returned separately. When `secureTransport` is given (Phase 9), the code
 * advertises HTTPS/WSS URLs + the certificate fingerprint the phone will pin.
 */
export function issuePairingCode(opts: {
  deviceName: string;
  issuedAt: string;
  /** Defaults to config's PAIRING_TTL_SECONDS; `<= 0` disables expiry (dev). */
  ttlSeconds?: number;
  store?: PairedDeviceStore;
  port?: number;
  hostOverride?: string;
  secureTransport?: SecureTransportInfo;
}): IssuedPairingCode {
  const store = opts.store ?? getPairedDeviceStore();
  const ttlSeconds = opts.ttlSeconds ?? PAIRING_TTL_SECONDS;
  const port = opts.port ?? PORT;
  const { host, isLoopbackFallback } = resolveAdvertisedHost(opts.hostOverride);

  const { record, rawToken } = store.issue({ deviceName: opts.deviceName, ttlSeconds });
  const payload = buildPairingPayload({
    port,
    token: rawToken,
    issuedAt: opts.issuedAt,
    host,
    expiresAt: record.expiresAt,
    secure: opts.secureTransport
      ? {
          httpsPort: opts.secureTransport.httpsPort,
          host: opts.secureTransport.hostname,
          fingerprintSha256: opts.secureTransport.fingerprintSha256,
          subject: opts.secureTransport.subject,
          certExpiresAt: opts.secureTransport.certExpiresAt,
        }
      : undefined,
  });

  return {
    url: encodePairingURL(payload),
    deviceId: record.id,
    deviceName: record.deviceName,
    expiresAt: record.expiresAt,
    host,
    isLoopbackFallback,
    secure: opts.secureTransport !== undefined,
  };
}
