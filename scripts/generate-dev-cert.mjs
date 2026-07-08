/**
 * Generate a local, self-signed dev TLS certificate for Orbitory (Phase 9).
 *
 *   npm run tls:generate            # writes to .orbitory/certs/ (gitignored)
 *   ORBITORY_TLS_HOSTNAME=192.168.1.10 npm run tls:generate
 *
 * SECURITY / SCOPE:
 * - This certificate is for LOCAL DEVELOPMENT only. It is self-signed (no CA), so
 *   trust comes entirely from the SHA-256 fingerprint the iOS app pins via the
 *   pairing code. See docs/PHASE9_TLS_WSS_LOCAL_TRANSPORT.md.
 * - The private key is written under the gitignored `.orbitory/certs/` dir and is
 *   NEVER committed or logged. Do not copy it anywhere shared.
 * - Requires `openssl` on PATH (OpenSSL 1.1.1+/3.x or LibreSSL 3.3+ for -addext).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { resolve } from "node:path";

const dir = process.env.ORBITORY_CERT_DIR ?? resolve(process.cwd(), ".orbitory", "certs");
const certPath = resolve(dir, "dev-cert.pem");
const keyPath = resolve(dir, "dev-key.pem");
const hostname = (process.env.ORBITORY_TLS_HOSTNAME ?? "orbitory-local").trim();

// Include the hostname as a SAN. If it looks like an IPv4 address, use IP:, else DNS:.
const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
const san = `subjectAltName=DNS:localhost,IP:127.0.0.1,${isIp ? "IP:" : "DNS:"}${hostname}`;

mkdirSync(dir, { recursive: true });

try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-subj", `/CN=${hostname}`,
      "-addext", san,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} catch (err) {
  console.error("\nFailed to run openssl. Is it installed and on your PATH?");
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

// Fingerprint = lowercase hex SHA-256 of the DER — the exact value the pairing
// code carries and the iOS app pins.
const der = new X509Certificate(readFileSync(certPath)).raw;
const fingerprint = createHash("sha256").update(der).digest("hex");

console.log(
  [
    "",
    "Generated a self-signed DEV TLS certificate (local development only).",
    "",
    `  cert: ${certPath}`,
    `  key:  ${keyPath}   (private — gitignored, never commit or share)`,
    `  SHA-256 fingerprint: ${fingerprint}`,
    "",
    "Run the host-agent over HTTPS/WSS with:",
    "",
    `  ORBITORY_TLS_ENABLED=true \\`,
    `  ORBITORY_TLS_CERT_PATH="${certPath}" \\`,
    `  ORBITORY_TLS_KEY_PATH="${keyPath}" \\`,
    isIp ? `  ORBITORY_TLS_HOSTNAME="${hostname}" \\` : `  ORBITORY_ADVERTISED_HOST=<LAN-IP> \\`,
    `  ORBITORY_PRINT_PAIRING_CODE=true npm run dev`,
    "",
    "The printed pairing code will carry this fingerprint; the iOS app pins it.",
    "",
  ].join("\n"),
);
