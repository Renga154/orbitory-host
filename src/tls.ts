/**
 * TLS material loading + certificate fingerprinting (Phase 9).
 *
 * Loads a PEM cert + key for HTTPS/WSS and computes the certificate's SHA-256
 * fingerprint (lowercase hex of the DER encoding) — the value the pairing code
 * carries so the iOS app can pin exactly this certificate.
 *
 * SECURITY:
 * - The private key is returned for the TLS server but is NEVER logged.
 * - The fingerprint is public trust metadata, not a secret.
 * - Loading fails CLEARLY (throws) on missing/unreadable/invalid material — the
 *   caller must never downgrade to plaintext when TLS was explicitly required.
 */

import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";

export interface TlsMaterials {
  /** PEM certificate bytes (for the HTTPS server). */
  cert: Buffer;
  /** PEM private key bytes (for the HTTPS server). NEVER log this. */
  key: Buffer;
  /** Lowercase hex SHA-256 of the certificate's DER encoding. */
  fingerprintSha256: string;
  /** Certificate subject, e.g. "CN=orbitory-local". */
  subject: string;
  /** Certificate `notAfter` as ISO 8601. */
  expiresAt: string;
}

/** Compute the lowercase-hex SHA-256 of a certificate's DER encoding. */
export function computeCertFingerprintSha256(cert: X509Certificate | Buffer | string): string {
  const x509 = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  return createHash("sha256").update(x509.raw).digest("hex");
}

/**
 * Load TLS cert + key from PEM files and derive fingerprint/subject/expiry.
 * Throws a clear, actionable error (never returns a partial result) if either
 * path is missing, unreadable, or not a valid certificate.
 */
export function loadTlsMaterials(opts: {
  certPath: string | undefined;
  keyPath: string | undefined;
}): TlsMaterials {
  if (!opts.certPath || !opts.keyPath) {
    throw new Error(
      "TLS is enabled (ORBITORY_TLS_ENABLED=true) but ORBITORY_TLS_CERT_PATH and/or " +
        "ORBITORY_TLS_KEY_PATH is not set. Provide both, or run `npm run tls:generate`.",
    );
  }

  let cert: Buffer;
  try {
    cert = readFileSync(opts.certPath);
  } catch (err) {
    throw new Error(`Cannot read TLS certificate at "${opts.certPath}": ${(err as Error).message}`);
  }

  let key: Buffer;
  try {
    key = readFileSync(opts.keyPath);
  } catch (err) {
    throw new Error(`Cannot read TLS private key at "${opts.keyPath}": ${(err as Error).message}`);
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch (err) {
    throw new Error(
      `TLS certificate at "${opts.certPath}" is not a valid X.509 certificate: ${(err as Error).message}`,
    );
  }

  return {
    cert,
    key,
    fingerprintSha256: computeCertFingerprintSha256(x509),
    // X509Certificate.subject can be multi-line ("CN=…\nO=…"); normalize to one line.
    subject: x509.subject.split("\n").join(", "),
    expiresAt: new Date(x509.validTo).toISOString(),
  };
}
