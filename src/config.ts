/**
 * Central configuration for the Orbitory host-agent process.
 *
 * All values are derived once, at module load time, from environment
 * variables. Nothing here performs I/O beyond reading `process.env` and
 * writing warnings to stderr via `console.warn`.
 */

import { normalizeBonjourServiceType, parseBonjourPort } from "./bonjour.js";

export const DEV_FALLBACK_PAIRING_TOKEN = "orbitory-dev-token";

function readPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") {
    return 4000;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid PORT value "${raw}"; falling back to 4000.`,
    );
    return 4000;
  }

  return parsed;
}

function readPairingToken(): string {
  const raw = process.env.ORBITORY_PAIRING_TOKEN;
  if (raw !== undefined && raw.trim() !== "") {
    return raw;
  }

  printDevPairingTokenWarning();
  return DEV_FALLBACK_PAIRING_TOKEN;
}

function printDevPairingTokenWarning(): void {
  const banner = [
    "",
    "############################################################",
    "#                                                          #",
    "#   WARNING: ORBITORY_PAIRING_TOKEN IS NOT SET             #",
    "#                                                          #",
    "#   Falling back to the well-known development token:     #",
    `#     "${DEV_FALLBACK_PAIRING_TOKEN}"${" ".repeat(
      Math.max(0, 33 - DEV_FALLBACK_PAIRING_TOKEN.length),
    )}#`,
    "#                                                          #",
    "#   This token is PUBLIC and offers NO real security.      #",
    "#   It must ONLY be used for local development.            #",
    "#   NEVER expose this server to the public internet        #",
    "#   while relying on this fallback token.                  #",
    "#                                                          #",
    "#   Set ORBITORY_PAIRING_TOKEN in your environment (or     #",
    "#   .env file) before deploying or exposing this host.     #",
    "#                                                          #",
    "############################################################",
    "",
  ].join("\n");

  console.warn(banner);
}

function readPairingTtlSeconds(): number {
  const DEFAULT_SECONDS = 600; // 10 minutes: long enough to scan, short enough to limit exposure.
  const raw = process.env.ORBITORY_PAIRING_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SECONDS;
  }
  const parsed = Number(raw);
  // 0 (or negative) explicitly disables expiry — a documented dev-only escape hatch.
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid ORBITORY_PAIRING_TTL_SECONDS value "${raw}"; falling back to ${DEFAULT_SECONDS}.`,
    );
    return DEFAULT_SECONDS;
  }
  return parsed;
}

function readPairedDevicesPath(): string {
  const raw = process.env.ORBITORY_PAIRED_DEVICES_PATH;
  if (raw !== undefined && raw.trim() !== "") {
    return raw.trim();
  }
  return `${process.cwd()}/.orbitory/paired-devices.json`;
}

function readStaticTokenEnabled(): boolean {
  // The static ORBITORY_PAIRING_TOKEN stays accepted by default for dev
  // compatibility (lower security, never expires). Operators can turn it off
  // once every client uses a per-device token.
  return process.env.ORBITORY_DISABLE_STATIC_TOKEN !== "true";
}

function readTlsEnabled(): boolean {
  return process.env.ORBITORY_TLS_ENABLED === "true";
}

function readHttpsPort(): number {
  const DEFAULT = 4443;
  const raw = process.env.ORBITORY_HTTPS_PORT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid ORBITORY_HTTPS_PORT value "${raw}"; falling back to ${DEFAULT}.`,
    );
    return DEFAULT;
  }
  return parsed;
}

function optionalTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.trim();
}

function readHelloTimeoutMs(): number {
  const DEFAULT_MS = 5_000;
  const raw = process.env.ORBITORY_HELLO_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid ORBITORY_HELLO_TIMEOUT_MS value "${raw}"; falling back to ${DEFAULT_MS}.`,
    );
    return DEFAULT_MS;
  }
  return parsed;
}

function readBonjourServiceType(): string {
  const raw = process.env.ORBITORY_BONJOUR_SERVICE_TYPE;
  const { serviceType, wasInvalid } = normalizeBonjourServiceType(raw);
  if (wasInvalid) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid ORBITORY_BONJOUR_SERVICE_TYPE value "${raw}"; falling back to ${serviceType}.`,
    );
  }
  return serviceType;
}

function readBonjourPort(): number | undefined {
  const raw = process.env.ORBITORY_BONJOUR_PORT;
  const { port, wasInvalid } = parseBonjourPort(raw);
  if (wasInvalid) {
    console.warn(
      `[orbitory-host-agent] Ignoring invalid ORBITORY_BONJOUR_PORT value "${raw}"; falling back to the server port.`,
    );
  }
  return port;
}

export const PORT: number = readPort();

export const PAIRING_TOKEN: string = readPairingToken();

/**
 * Default TTL (seconds) applied to freshly issued per-device pairing tokens and
 * the pairing codes that carry them. `0` disables expiry (dev-only). See
 * `docs/PHASE8_QR_PAIRING_HARDENING.md`.
 */
export const PAIRING_TTL_SECONDS: number = readPairingTtlSeconds();

/** Where the per-device pairing-token store is persisted (JSON, hashes only). */
export const PAIRED_DEVICES_PATH: string = readPairedDevicesPath();

/**
 * Whether the static `ORBITORY_PAIRING_TOKEN` is still accepted at auth. Default
 * true (dev compatibility); set `ORBITORY_DISABLE_STATIC_TOKEN=true` to require
 * per-device tokens.
 */
export const STATIC_TOKEN_ENABLED: boolean = readStaticTokenEnabled();

/**
 * TLS transport (Phase 9). When enabled, the host-agent serves HTTPS/WSS on
 * `HTTPS_PORT` (single transport — no plaintext port is opened, so there is no
 * silent downgrade). Cert/key are PEM file paths the operator provides (or that
 * `npm run tls:generate` writes under `.orbitory/certs/`). See
 * `docs/PHASE9_TLS_WSS_LOCAL_TRANSPORT.md`.
 */
export const TLS_ENABLED: boolean = readTlsEnabled();
export const TLS_CERT_PATH: string | undefined = optionalTrimmed("ORBITORY_TLS_CERT_PATH");
export const TLS_KEY_PATH: string | undefined = optionalTrimmed("ORBITORY_TLS_KEY_PATH");
/** Hostname/IP the TLS URLs advertise; falls back to the resolved advertised host. */
export const TLS_HOSTNAME: string | undefined = optionalTrimmed("ORBITORY_TLS_HOSTNAME");
export const HTTPS_PORT: number = readHttpsPort();

/**
 * Bonjour/mDNS host discovery (Phase 13). **Opt-in, disabled by default.** When
 * enabled, the host-agent advertises `_orbitory._tcp` on the local network with
 * safe metadata ONLY (product/version/hostId/hostName/tls hint/port/wsPath/
 * pairingRequired) — never a token, provider config, command, path, or secret.
 * Discovery is not authentication; pairing is still required. See
 * `docs/PHASE13_BONJOUR_HOST_DISCOVERY.md` and `docs/security.md`.
 */
export const BONJOUR_ENABLED: boolean = process.env.ORBITORY_BONJOUR_ENABLED === "true";
/** Human-readable service name; `bonjour.ts` falls back to `os.hostname()` when unset. */
export const BONJOUR_NAME: string | undefined = optionalTrimmed("ORBITORY_BONJOUR_NAME");
/** mDNS service type (validated); default `_orbitory._tcp`. */
export const BONJOUR_SERVICE_TYPE: string = readBonjourServiceType();
/** Advertised port; defaults to the effective listen port (HTTPS_PORT under TLS, else PORT). */
export const BONJOUR_PORT: number | undefined = readBonjourPort();
/**
 * When true, a failure to start advertisement is **fatal** (fail-closed) rather
 * than best-effort — startup exits non-zero instead of silently not advertising.
 */
export const BONJOUR_REQUIRED: boolean = process.env.ORBITORY_BONJOUR_REQUIRED === "true";

/**
 * Audit log (Phase 10). Append-only JSONL of sanitized supervision events. Path
 * defaults to the gitignored `.orbitory/` data dir; `AUDIT_MAX_EVENTS` caps the
 * in-memory ring buffer (and how many recent lines load on startup).
 */
export const AUDIT_LOG_PATH: string =
  optionalTrimmed("ORBITORY_AUDIT_LOG_PATH") ?? `${process.cwd()}/.orbitory/audit.log.jsonl`;

export const AUDIT_MAX_EVENTS: number = (() => {
  const DEFAULT = 500;
  const raw = process.env.ORBITORY_AUDIT_MAX_EVENTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT;
})();

/**
 * Demo seeding (Phase 16). **Off by default.** When `ORBITORY_DEMO_SESSIONS=true`,
 * `sessionStore` seeds the 3 fake demo hosts + 4 simulated sessions that used
 * to be unconditional, so screenshots/demos still work on demand. Without it,
 * a fresh host-agent starts honestly: one real local host row
 * (`os.hostname()`) and zero sessions. Read once at module load —
 * `sessionStore` is a singleton created at import time.
 */
export const DEMO_SESSIONS_ENABLED: boolean = process.env.ORBITORY_DEMO_SESSIONS === "true";

export const NODE_ENV: string = process.env.NODE_ENV ?? "development";

/**
 * How long the WebSocket handshake waits for a `client.hello` carrying the
 * pairing token before giving up with a `handshake_timeout` error. 5s by
 * default (matching docs/protocol.md §3); overridable via
 * ORBITORY_HELLO_TIMEOUT_MS — primarily so the test suite doesn't have to
 * wait out the full production window (see package.json's "test" script).
 */
export const HELLO_TIMEOUT_MS: number = readHelloTimeoutMs();
