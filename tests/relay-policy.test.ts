import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  RELAY_AUDITED_CRYPTOGRAPHIC_PROVIDERS,
  RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_MAX_BUFFERED_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_SEQUENCE,
  RELAY_NOISE_PATTERN,
  RELAY_RELEASE_EVIDENCE,
  evaluateRelayLaunchGate,
  relayReconnectDelaySeconds,
  validateRelayFrame,
} from "../src/relayPolicy.js";

const reviewedConfiguration = {
  relayUrl: "wss://relay.orbitory.example/v1/connect",
  cryptographicProviderId: "future-audited-noise-provider",
  releaseDecisionApproved: true,
  pairingTokenConfigured: true,
  staticPairingTokenDisabled: true,
  threatModelReviewed: true,
  cryptographicReviewCompleted: true,
  replayAndOrderingReviewCompleted: true,
  privacyReviewCompleted: true,
  exportComplianceReviewed: true,
  killSwitchEnabled: true,
  keyStorageReviewed: true,
  interoperabilityReviewCompleted: true,
  revocationReviewCompleted: true,
  physical4GReviewCompleted: true,
  soak24HourReviewCompleted: true,
} as const;

describe("Orbitory Relay security policy", () => {
  test("keeps protocol and cryptographic identifiers separate from the app protocol", () => {
    assert.equal(RELAY_CONTROL_PROTOCOL_VERSION, "0.1");
    assert.equal(RELAY_NOISE_PATTERN, "Noise_XX_25519_ChaChaPoly_SHA256");
  });

  test("has no audited cryptographic provider until an external review approves one", () => {
    assert.deepEqual(RELAY_AUDITED_CRYPTOGRAPHIC_PROVIDERS, []);
    assert.equal(RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID, undefined);
    assert.equal(RELAY_RELEASE_EVIDENCE.status, "no-go");
    assert.deepEqual(
      Object.entries(RELAY_RELEASE_EVIDENCE)
        .filter(([key]) => key !== "schemaVersion" && key !== "status")
        .map(([, value]) => value),
      Array(10).fill(false),
    );
  });

  test("fails closed with no configuration", () => {
    const decision = evaluateRelayLaunchGate({
      releaseDecisionApproved: false,
      pairingTokenConfigured: false,
      staticPairingTokenDisabled: false,
      threatModelReviewed: false,
      cryptographicReviewCompleted: false,
      replayAndOrderingReviewCompleted: false,
      privacyReviewCompleted: false,
      exportComplianceReviewed: false,
      killSwitchEnabled: false,
      keyStorageReviewed: false,
      interoperabilityReviewCompleted: false,
      revocationReviewCompleted: false,
      physical4GReviewCompleted: false,
      soak24HourReviewCompleted: false,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, "blocked");
    assert.ok(decision.blockCodes.includes("missing_relay_url"));
    assert.ok(decision.blockCodes.includes("release_evidence_not_approved"));
    assert.ok(decision.blockCodes.includes("pairing_token_required"));
    assert.ok(decision.blockCodes.includes("static_pairing_token_enabled"));
    assert.ok(decision.blockCodes.includes("interoperability_review_required"));
    assert.ok(decision.blockCodes.includes("revocation_review_required"));
    assert.ok(decision.blockCodes.includes("physical_4g_review_required"));
    assert.ok(decision.blockCodes.includes("soak_24_hour_review_required"));
    assert.ok(decision.blockCodes.includes("cryptographic_provider_unapproved"));
  });

  test("rejects plaintext and credential-bearing relay URLs", () => {
    const plaintext = evaluateRelayLaunchGate({
      ...reviewedConfiguration,
      relayUrl: "ws://relay.orbitory.example/connect",
    });
    const credentials = evaluateRelayLaunchGate({
      ...reviewedConfiguration,
      relayUrl: "wss://operator:secret@relay.orbitory.example/connect",
    });

    assert.ok(plaintext.blockCodes.includes("relay_url_must_use_wss"));
    assert.ok(credentials.blockCodes.includes("relay_url_contains_credentials"));
  });

  test("does not treat review environment flags as approval for an unknown crypto implementation", () => {
    const decision = evaluateRelayLaunchGate(reviewedConfiguration);

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockCodes, ["cryptographic_provider_unapproved"]);
  });

  test("requires an explicit compiled go decision independently of completed review fields", () => {
    const decision = evaluateRelayLaunchGate({
      ...reviewedConfiguration,
      releaseDecisionApproved: false,
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.blockCodes.includes("release_evidence_not_approved"));
  });

  test("rejects development-style static authentication before any network is opened", () => {
    const decision = evaluateRelayLaunchGate({
      ...reviewedConfiguration,
      pairingTokenConfigured: false,
      staticPairingTokenDisabled: false,
    });

    assert.ok(decision.blockCodes.includes("pairing_token_required"));
    assert.ok(decision.blockCodes.includes("static_pairing_token_enabled"));
  });

  test("rejects oversized and over-buffered encrypted frames", () => {
    const oversized = validateRelayFrame({
      ciphertextByteLength: RELAY_MAX_FRAME_BYTES + 1,
      bufferedByteLength: 0,
      sequence: 0n,
    });
    const overBuffered = validateRelayFrame({
      ciphertextByteLength: 1,
      bufferedByteLength: RELAY_MAX_BUFFERED_BYTES,
      sequence: 0n,
    });

    assert.deepEqual(oversized, { accepted: false, reason: "frame_too_large" });
    assert.deepEqual(overBuffered, { accepted: false, reason: "buffer_limit_exceeded" });
  });

  test("rejects replayed, skipped, and negative frame sequence numbers", () => {
    const replay = validateRelayFrame({
      ciphertextByteLength: 32,
      bufferedByteLength: 0,
      lastAcceptedSequence: 3n,
      sequence: 3n,
    });
    const skipped = validateRelayFrame({
      ciphertextByteLength: 32,
      bufferedByteLength: 0,
      lastAcceptedSequence: 3n,
      sequence: 5n,
    });
    const negative = validateRelayFrame({
      ciphertextByteLength: 32,
      bufferedByteLength: 0,
      sequence: -1n,
    });
    const oversized = validateRelayFrame({
      ciphertextByteLength: 32,
      bufferedByteLength: 0,
      sequence: RELAY_MAX_SEQUENCE + 1n,
    });
    const exhausted = validateRelayFrame({
      ciphertextByteLength: 32,
      bufferedByteLength: 0,
      lastAcceptedSequence: RELAY_MAX_SEQUENCE,
      sequence: RELAY_MAX_SEQUENCE,
    });

    assert.deepEqual(replay, { accepted: false, reason: "replay_or_out_of_order" });
    assert.deepEqual(skipped, { accepted: false, reason: "replay_or_out_of_order" });
    assert.deepEqual(negative, { accepted: false, reason: "invalid_sequence" });
    assert.deepEqual(oversized, { accepted: false, reason: "invalid_sequence" });
    assert.deepEqual(exhausted, { accepted: false, reason: "sequence_exhausted" });
  });

  test("accepts only the next encrypted frame sequence", () => {
    assert.deepEqual(
      validateRelayFrame({
        ciphertextByteLength: 128,
        bufferedByteLength: 256,
        sequence: 0n,
      }),
      { accepted: true, nextLastAcceptedSequence: 0n },
    );
    assert.deepEqual(
      validateRelayFrame({
        ciphertextByteLength: 128,
        bufferedByteLength: 256,
        lastAcceptedSequence: 0n,
        sequence: 1n,
      }),
      { accepted: true, nextLastAcceptedSequence: 1n },
    );
  });

  test("uses a bounded reconnect backoff", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 100].map(relayReconnectDelaySeconds),
      [1, 2, 4, 8, 15, 30, 30, 30],
    );
    assert.equal(relayReconnectDelaySeconds(-1), 1);
    assert.equal(relayReconnectDelaySeconds(Number.NaN), 1);
  });
});
