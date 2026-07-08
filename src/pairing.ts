/**
 * Pairing payload + QR-friendly pairing URL (Phase 7).
 *
 * Produces a single, versioned `orbitory://pair?payload=<base64url-json>` string
 * a host operator can print (opt-in) and encode as a QR code, so the iOS app can
 * pair by pasting/scanning instead of hand-typing a URL + token.
 *
 * SECURITY: the payload contains the pairing **token**, so the pairing code is a
 * secret — anyone who can read it (terminal, screenshot, QR photo, or the local
 * network before TLS) can connect. `base64url` is *encoding, not encryption*.
 * The payload deliberately contains ONLY connection details + the token — never
 * `command`/`args`/`env`/`image`/`workingDirectory` or any provider config (a
 * test asserts this). See `docs/PHASE7_PAIRING_UX.md` and `docs/security.md`.
 */

import * as os from "node:os";

/** The scheme + host for the custom pairing URL: `orbitory://pair?payload=…`. */
export const PAIRING_URL_SCHEME = "orbitory";
export const PAIRING_URL_HOST = "pair";

/** Current pairing-payload schema version. Bump only on a breaking shape change. */
export const PAIRING_PAYLOAD_VERSION = 1;

/** Product discriminator so a foreign `orbitory://` link can't be mistaken for ours. */
export const PAIRING_PRODUCT = "Orbitory";

/**
 * Transport-security trust metadata (Phase 9). Present with `mode: "tls"` when
 * the host serves HTTPS/WSS; the fingerprint is PUBLIC trust metadata (not a
 * secret) the iOS app pins. Absent entirely on plaintext (Phase 7/8) codes.
 */
export interface TransportSecurity {
  mode: "tls" | "plaintext";
  /** Lowercase hex SHA-256 of the server cert's DER (present for `tls`). */
  certificateFingerprintSha256: string | null;
  /** Certificate subject, e.g. "CN=orbitory-local". */
  certificateSubject: string | null;
  /** Certificate `notAfter` as ISO 8601. */
  expiresAt: string | null;
}

/**
 * The versioned pairing payload. Connection details + token + transport trust
 * metadata ONLY — no provider config, no execution fields, no host filesystem
 * paths beyond the URLs. The certificate fingerprint is public trust metadata,
 * not a secret.
 *
 * Transport modes (Phase 9): plaintext codes carry `httpUrl`/`wsUrl` (the
 * `https*` fields null, `transportSecurity` null — back-compat with Phase 7/8);
 * TLS codes carry `httpsUrl`/`wssUrl` + `transportSecurity{mode:"tls",…}` (the
 * plaintext fields null, since a TLS host serves only HTTPS/WSS).
 */
export interface PairingPayload {
  version: number;
  product: "Orbitory";
  /** Informational host id (os.hostname()); not a security boundary. */
  hostId: string;
  /** Human-readable host label for the profile. */
  hostName: string;
  /** Plaintext REST base, e.g. `http://192.168.1.10:4000` (null in TLS mode). */
  httpUrl: string | null;
  /** Plaintext WebSocket URL, e.g. `ws://192.168.1.10:4000/ws` (null in TLS mode). */
  wsUrl: string | null;
  /** Secure REST base, e.g. `https://192.168.1.10:4443` (null in plaintext mode). */
  httpsUrl: string | null;
  /** Secure WebSocket URL, e.g. `wss://192.168.1.10:4443/ws` (null in plaintext mode). */
  wssUrl: string | null;
  /** The pairing token. This is why the whole payload is sensitive. */
  token: string;
  /** ISO 8601 issue time. */
  issuedAt: string;
  /**
   * ISO 8601 expiry (Phase 8) — the same instant the per-device token expires
   * server-side. `verifyPresentedToken` rejects an expired token at connect, and
   * iOS `PairingCode.parse` also pre-rejects a past `expiresAt`. `null` only when
   * TTL is disabled (`ORBITORY_PAIRING_TTL_SECONDS=0`, dev).
   */
  expiresAt: string | null;
  /** Transport trust metadata (Phase 9); null on plaintext codes. */
  transportSecurity: TransportSecurity | null;
}

/** Encode a Buffer/string as unpadded base64url. */
export function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode unpadded base64url back to a UTF-8 string. */
export function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * The host address to advertise in the pairing URLs. `ORBITORY_ADVERTISED_HOST`
 * (operator override) wins; otherwise the first non-internal IPv4 interface;
 * otherwise `127.0.0.1` (localhost — only reachable from the same machine, so
 * the caller warns and asks the operator to set `ORBITORY_ADVERTISED_HOST`).
 */
export function resolveAdvertisedHost(
  override: string | undefined = process.env["ORBITORY_ADVERTISED_HOST"],
): { host: string; isLoopbackFallback: boolean } {
  if (override !== undefined && override.trim().length > 0) {
    return { host: override.trim(), isLoopbackFallback: false };
  }
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return { host: addr.address, isLoopbackFallback: false };
      }
    }
  }
  return { host: "127.0.0.1", isLoopbackFallback: true };
}

/**
 * Build the pairing payload from the running server's port + token. Pure aside
 * from reading `os.hostname()` / interfaces (both injectable for tests).
 */
export function buildPairingPayload(params: {
  port: number;
  token: string;
  issuedAt: string;
  host?: string;
  hostName?: string;
  /** ISO 8601 expiry, or null to disable (dev). Phase 8 ties this to the per-device token's server-side expiry. */
  expiresAt?: string | null;
  /**
   * Phase 9 TLS. When present, the code advertises secure URLs + the cert
   * fingerprint the phone pins, and the plaintext URLs are null (a TLS host
   * serves only HTTPS/WSS — no plaintext port, so no silent downgrade).
   */
  secure?: {
    httpsPort: number;
    /** TLS hostname override; defaults to the resolved advertised host. */
    host?: string;
    fingerprintSha256: string;
    subject: string;
    /** Certificate `notAfter`, ISO 8601. */
    certExpiresAt: string | null;
  };
}): PairingPayload {
  const host = params.host ?? resolveAdvertisedHost().host;
  const hostName = params.hostName ?? os.hostname();
  const base = {
    version: PAIRING_PAYLOAD_VERSION,
    product: PAIRING_PRODUCT,
    hostId: os.hostname(),
    hostName,
    token: params.token,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt ?? null,
  } as const;

  if (params.secure) {
    const sHost = params.secure.host ?? host;
    return {
      ...base,
      httpUrl: null,
      wsUrl: null,
      httpsUrl: `https://${sHost}:${params.secure.httpsPort}`,
      wssUrl: `wss://${sHost}:${params.secure.httpsPort}/ws`,
      transportSecurity: {
        mode: "tls",
        certificateFingerprintSha256: params.secure.fingerprintSha256,
        certificateSubject: params.secure.subject,
        expiresAt: params.secure.certExpiresAt,
      },
    };
  }

  return {
    ...base,
    httpUrl: `http://${host}:${params.port}`,
    wsUrl: `ws://${host}:${params.port}/ws`,
    httpsUrl: null,
    wssUrl: null,
    transportSecurity: null,
  };
}

/** Encode a payload as the QR-friendly `orbitory://pair?payload=<base64url-json>` URL. */
export function encodePairingURL(payload: PairingPayload): string {
  const json = JSON.stringify(payload);
  return `${PAIRING_URL_SCHEME}://${PAIRING_URL_HOST}?payload=${toBase64Url(json)}`;
}

/**
 * Decode + validate a pairing URL back into a payload. Returns `null` for
 * anything malformed, wrong-scheme, unsupported-version, or missing a token —
 * mirroring the validation the iOS parser performs, so the round-trip is tested
 * on the host side too. Never throws.
 */
export function decodePairingURL(url: string): PairingPayload | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PAIRING_URL_SCHEME}:` || parsed.host !== PAIRING_URL_HOST) {
    return null;
  }
  const encoded = parsed.searchParams.get("payload");
  if (encoded === null || encoded.length === 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  if (p["version"] !== PAIRING_PAYLOAD_VERSION || p["product"] !== PAIRING_PRODUCT) {
    return null;
  }
  for (const key of ["hostId", "hostName", "token", "issuedAt"] as const) {
    if (typeof p[key] !== "string" || (p[key] as string).length === 0) {
      return null;
    }
  }
  const asStringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const httpUrl = asStringOrNull(p["httpUrl"]);
  const wsUrl = asStringOrNull(p["wsUrl"]);
  const httpsUrl = asStringOrNull(p["httpsUrl"]);
  const wssUrl = asStringOrNull(p["wssUrl"]);

  const hasPlaintext = httpUrl !== null && wsUrl !== null;
  const hasSecure = httpsUrl !== null && wssUrl !== null;

  // Fail closed: if `transportSecurity` is PRESENT but malformed (unknown mode,
  // or `tls` without a valid fingerprint), reject the whole code rather than
  // silently dropping the trust metadata and downgrading to no pinning.
  const rawTs = p["transportSecurity"];
  let transportSecurity: TransportSecurity | null = null;
  if (rawTs !== undefined && rawTs !== null) {
    transportSecurity = parseTransportSecurity(rawTs);
    if (transportSecurity === null) {
      return null;
    }
  }

  // Require the connection pair that matches the declared transport, mirroring
  // the iOS parser exactly (`PairingCode.resolveTransport`): a `tls` code must
  // carry a secure (wss+https) pair, and a plaintext code (explicit `plaintext`
  // mode OR no `transportSecurity`) must carry a plaintext (ws+http) pair. This
  // fails closed on a secure-URL-only code that lacks pinning metadata — which
  // would otherwise bless a wss target with no fingerprint to pin.
  if (transportSecurity?.mode === "tls") {
    if (!hasSecure) return null;
  } else {
    if (!hasPlaintext) return null;
  }

  return {
    version: PAIRING_PAYLOAD_VERSION,
    product: PAIRING_PRODUCT,
    hostId: p["hostId"] as string,
    hostName: p["hostName"] as string,
    httpUrl,
    wsUrl,
    httpsUrl,
    wssUrl,
    token: p["token"] as string,
    issuedAt: p["issuedAt"] as string,
    expiresAt: asStringOrNull(p["expiresAt"]),
    transportSecurity,
  };
}

/**
 * Parse the optional `transportSecurity` block. Returns null when absent; for a
 * `tls` mode it requires a well-formed 64-hex fingerprint (the pinning root of
 * trust). An unknown mode or a malformed `tls` block is rejected (null).
 */
export function parseTransportSecurity(v: unknown): TransportSecurity | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "object") {
    return null;
  }
  const t = v as Record<string, unknown>;
  const mode = t["mode"];
  if (mode !== "tls" && mode !== "plaintext") {
    return null;
  }
  const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
  const fingerprint = str(t["certificateFingerprintSha256"]);
  if (mode === "tls" && (fingerprint === null || !/^[0-9a-f]{64}$/.test(fingerprint))) {
    return null;
  }
  return {
    mode,
    certificateFingerprintSha256: fingerprint,
    certificateSubject: str(t["certificateSubject"]),
    expiresAt: str(t["expiresAt"]),
  };
}
