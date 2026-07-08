/**
 * Pairing CLI (Phase 8): issue, list, and revoke per-device pairing tokens.
 *
 *   npm run pairing:print  -- --name "iPhone" [--ttl 600]
 *   npm run pairing:list
 *   npm run pairing:revoke -- <device-id>
 *
 * `print` mints a fresh, EXPIRING per-device token and prints its
 * `orbitory://pair?payload=…` code (the raw token lives only inside that URL —
 * never persisted, never logged separately). Operates on the same file-backed
 * store (`ORBITORY_PAIRED_DEVICES_PATH`) a running server reads, so a code
 * printed here is immediately usable against that server.
 *
 * SECURITY: anyone who can see a printed code can connect until it expires.
 */

import { getPairedDeviceStore } from "../src/auth.js";
import { recordTokenRevoked } from "../src/audit.js";
import { HTTPS_PORT, PAIRING_TTL_SECONDS, TLS_CERT_PATH, TLS_ENABLED, TLS_HOSTNAME, TLS_KEY_PATH } from "../src/config.js";
import { issuePairingCode, type SecureTransportInfo } from "../src/pairingIssue.js";
import { loadTlsMaterials } from "../src/tls.js";

function parseFlags(args: string[]): { name?: string; ttl?: number; positional: string[] } {
  const out: { name?: string; ttl?: number; positional: string[] } = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") {
      out.name = args[++i];
    } else if (a === "--ttl") {
      const n = Number(args[++i]);
      if (Number.isInteger(n) && n >= 0) out.ttl = n;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function printCode(args: string[]): void {
  const { name, ttl } = parseFlags(args);
  // Phase 9: if TLS is enabled, advertise HTTPS/WSS + the cert fingerprint so the
  // code matches what the (separately-run) TLS server will present.
  let secureTransport: SecureTransportInfo | undefined;
  if (TLS_ENABLED) {
    const tls = loadTlsMaterials({ certPath: TLS_CERT_PATH, keyPath: TLS_KEY_PATH });
    secureTransport = {
      fingerprintSha256: tls.fingerprintSha256,
      subject: tls.subject,
      certExpiresAt: tls.expiresAt,
      httpsPort: HTTPS_PORT,
      hostname: TLS_HOSTNAME,
    };
  }
  const issued = issuePairingCode({
    deviceName: name ?? "Orbitory iOS",
    issuedAt: new Date().toISOString(),
    ttlSeconds: ttl,
    secureTransport,
  });
  const ttlSeconds = ttl ?? PAIRING_TTL_SECONDS;

  console.log(
    [
      "",
      "------------------------------------------------------------",
      " ORBITORY PAIRING CODE (sensitive — contains a device token)",
      "------------------------------------------------------------",
      " Anyone who can see this code can connect until it expires.",
      " Do not share it or let it be photographed.",
      "",
      ` ${issued.url}`,
      "",
      ` Device:  ${issued.deviceName}  (${issued.deviceId})`,
      issued.expiresAt
        ? ` Expires: ${issued.expiresAt}  (TTL ${ttlSeconds}s)`
        : " Expires: never (TTL disabled — dev only)",
      issued.secure
        ? " Transport: TLS/WSS (the app pins the cert fingerprint)."
        : " Transport: plaintext WS (not encrypted — set ORBITORY_TLS_ENABLED=true for WSS).",
      issued.isLoopbackFallback
        ? " NOTE: advertised host is 127.0.0.1 (localhost only). Set\n ORBITORY_ADVERTISED_HOST=<LAN-IP> so a phone can reach it."
        : ` Advertised host: ${issued.host}`,
      "------------------------------------------------------------",
      "",
    ].join("\n"),
  );
}

function listCodes(): void {
  const devices = getPairedDeviceStore().list();
  if (devices.length === 0) {
    console.log("No paired-device tokens.");
    return;
  }
  console.log(`${devices.length} paired-device token(s):\n`);
  for (const d of devices) {
    const state = d.revokedAt
      ? `revoked ${d.revokedAt}`
      : d.expiresAt && Date.parse(d.expiresAt) < Date.now()
        ? `expired ${d.expiresAt}`
        : d.expiresAt
          ? `expires ${d.expiresAt}`
          : "no expiry";
    console.log(
      `  ${d.id}  "${d.deviceName}"  created ${d.createdAt}  lastUsed ${d.lastUsedAt ?? "never"}  [${state}]`,
    );
  }
}

function revokeCode(args: string[]): void {
  const id = parseFlags(args).positional[0];
  if (!id) {
    console.error("Usage: npm run pairing:revoke -- <device-id>");
    process.exitCode = 1;
    return;
  }
  const store = getPairedDeviceStore();
  const deviceName = store.list().find((d) => d.id === id)?.deviceName ?? id;
  const ok = store.revoke(id);
  if (ok) {
    // Phase 10: record a pairing.token.revoked audit event (device id + name
    // only — never a token or its hash). A running server picks this up from the
    // audit log on its next start (the CLI is a separate process).
    recordTokenRevoked(id, deviceName);
    console.log(`Revoked ${id}. It can no longer authenticate.`);
  } else {
    console.error(`No revocable token with id "${id}" (unknown or already revoked).`);
    process.exitCode = 1;
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "print":
      printCode(rest);
      break;
    case "list":
      listCodes();
      break;
    case "revoke":
      revokeCode(rest);
      break;
    default:
      console.error(
        [
          "Orbitory pairing CLI",
          "  npm run pairing:print  -- --name \"iPhone\" [--ttl 600]",
          "  npm run pairing:list",
          "  npm run pairing:revoke -- <device-id>",
        ].join("\n"),
      );
      process.exitCode = 1;
  }
}

main();
