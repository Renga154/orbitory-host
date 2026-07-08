/**
 * Phase 9 — TLS material loading + certificate fingerprint tests.
 *
 * Uses the committed throwaway fixture cert (tests/fixtures/tls/, see its README).
 * Asserts a stable SHA-256 fingerprint and that bad TLS config fails CLEARLY
 * (throws) rather than silently degrading.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeCertFingerprintSha256, loadTlsMaterials } from "../src/tls.js";

const CERT = join(process.cwd(), "tests", "fixtures", "tls", "test-cert.pem");
const KEY = join(process.cwd(), "tests", "fixtures", "tls", "test-key.pem");
const README = join(process.cwd(), "tests", "fixtures", "tls", "README.md");

// Recompute this if the fixture is ever regenerated (see the fixture README).
const EXPECTED_FINGERPRINT = "6ed0ddda12d53140ffaea7a76ca12ef8736e466135c0e437ce9455f1281e90ac";

describe("tls: fingerprint", () => {
  test("is a stable lowercase-hex SHA-256 of the DER", () => {
    const fp1 = computeCertFingerprintSha256(readFileSync(CERT));
    const fp2 = computeCertFingerprintSha256(readFileSync(CERT));
    assert.match(fp1, /^[0-9a-f]{64}$/);
    assert.equal(fp1, fp2, "fingerprint must be deterministic");
    assert.equal(fp1, EXPECTED_FINGERPRINT);
  });
});

describe("tls: loadTlsMaterials", () => {
  test("loads cert + key and derives fingerprint/subject/expiry", () => {
    const m = loadTlsMaterials({ certPath: CERT, keyPath: KEY });
    assert.ok(m.cert.length > 0);
    assert.ok(m.key.length > 0);
    assert.equal(m.fingerprintSha256, EXPECTED_FINGERPRINT);
    assert.match(m.subject, /orbitory-test/);
    assert.match(m.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("fails clearly when cert/key paths are not provided", () => {
    assert.throws(
      () => loadTlsMaterials({ certPath: undefined, keyPath: KEY }),
      /ORBITORY_TLS_CERT_PATH/,
    );
    assert.throws(
      () => loadTlsMaterials({ certPath: CERT, keyPath: undefined }),
      /ORBITORY_TLS_CERT_PATH|ORBITORY_TLS_KEY_PATH/,
    );
  });

  test("fails clearly when the cert file is missing", () => {
    assert.throws(
      () => loadTlsMaterials({ certPath: join(process.cwd(), "nope-cert.pem"), keyPath: KEY }),
      /Cannot read TLS certificate/,
    );
  });

  test("fails clearly when the cert file is not a valid certificate", () => {
    // The README is a real file but not a PEM certificate.
    assert.throws(
      () => loadTlsMaterials({ certPath: README, keyPath: KEY }),
      /not a valid X\.509 certificate/,
    );
  });
});
