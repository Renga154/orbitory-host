/**
 * Security gate for the future Orbitory Relay transport.
 *
 * This module is deliberately transport-free: importing it cannot open a
 * socket, resolve DNS, or start a host. The audited provider list stays empty
 * until a compatible Node/iOS Noise XX implementation passes external review.
 */

export const RELAY_CONTROL_PROTOCOL_VERSION = "0.1" as const;
export const RELAY_NOISE_PATTERN = "Noise_XX_25519_ChaChaPoly_SHA256" as const;
export const RELAY_MAX_FRAME_BYTES = 1_048_576;
export const RELAY_MAX_BUFFERED_BYTES = 2_097_152;
export const RELAY_MAX_RESERVATIONS_PER_CHANNEL = 1_024;
export const RELAY_MAX_SEQUENCE = (1n << 64n) - 1n;
export const RELAY_MAX_JOIN_TICKET_TTL_SECONDS = 60;
export const RELAY_MAX_KEY_AGE_SECONDS = 30 * 24 * 60 * 60;
export const RELAY_RECONNECT_BACKOFF_SECONDS = [1, 2, 4, 8, 15, 30] as const;

// Adding an id here is a release-gated security decision, not configuration.
export const RELAY_AUDITED_CRYPTOGRAPHIC_PROVIDERS: readonly string[] = Object.freeze([]);

export interface RelayReleaseEvidence {
  schemaVersion: 1;
  status: "go" | "no-go";
  threatModelReviewed: boolean;
  cryptographicReviewCompleted: boolean;
  replayAndOrderingReviewCompleted: boolean;
  privacyReviewCompleted: boolean;
  exportComplianceReviewed: boolean;
  keyStorageReviewed: boolean;
  interoperabilityReviewCompleted: boolean;
  revocationReviewCompleted: boolean;
  physical4GReviewCompleted: boolean;
  soak24HourReviewCompleted: boolean;
}

// Release evidence is compiled with the package. Runtime environment variables
// cannot claim that a security review happened or select a crypto provider.
export const RELAY_RELEASE_EVIDENCE: Readonly<RelayReleaseEvidence> = Object.freeze({
  schemaVersion: 1,
  status: "no-go",
  threatModelReviewed: false,
  cryptographicReviewCompleted: false,
  replayAndOrderingReviewCompleted: false,
  privacyReviewCompleted: false,
  exportComplianceReviewed: false,
  keyStorageReviewed: false,
  interoperabilityReviewCompleted: false,
  revocationReviewCompleted: false,
  physical4GReviewCompleted: false,
  soak24HourReviewCompleted: false,
});

export const RELAY_COMPILED_CRYPTOGRAPHIC_PROVIDER_ID: string | undefined = undefined;

export type RelayLaunchBlockCode =
  | "missing_relay_url"
  | "invalid_relay_url"
  | "relay_url_must_use_wss"
  | "relay_url_contains_credentials"
  | "release_evidence_not_approved"
  | "pairing_token_required"
  | "static_pairing_token_enabled"
  | "threat_model_review_required"
  | "cryptographic_review_required"
  | "replay_review_required"
  | "privacy_review_required"
  | "export_review_required"
  | "kill_switch_required"
  | "key_storage_review_required"
  | "interoperability_review_required"
  | "revocation_review_required"
  | "physical_4g_review_required"
  | "soak_24_hour_review_required"
  | "cryptographic_provider_unapproved";

export interface RelayLaunchGateInput {
  relayUrl?: string;
  cryptographicProviderId?: string;
  releaseDecisionApproved: boolean;
  pairingTokenConfigured: boolean;
  staticPairingTokenDisabled: boolean;
  threatModelReviewed: boolean;
  cryptographicReviewCompleted: boolean;
  replayAndOrderingReviewCompleted: boolean;
  privacyReviewCompleted: boolean;
  exportComplianceReviewed: boolean;
  killSwitchEnabled: boolean;
  keyStorageReviewed: boolean;
  interoperabilityReviewCompleted: boolean;
  revocationReviewCompleted: boolean;
  physical4GReviewCompleted: boolean;
  soak24HourReviewCompleted: boolean;
}

export interface RelayLaunchGateDecision {
  allowed: boolean;
  state: "ready" | "blocked";
  blockCodes: RelayLaunchBlockCode[];
}

export function evaluateRelayLaunchGate(input: RelayLaunchGateInput): RelayLaunchGateDecision {
  const blockCodes: RelayLaunchBlockCode[] = [];

  if (!input.relayUrl?.trim()) {
    blockCodes.push("missing_relay_url");
  } else {
    try {
      const relayUrl = new URL(input.relayUrl);
      if (relayUrl.protocol !== "wss:") {
        blockCodes.push("relay_url_must_use_wss");
      }
      if (relayUrl.username !== "" || relayUrl.password !== "") {
        blockCodes.push("relay_url_contains_credentials");
      }
    } catch {
      blockCodes.push("invalid_relay_url");
    }
  }

  if (!input.releaseDecisionApproved) blockCodes.push("release_evidence_not_approved");
  if (!input.pairingTokenConfigured) blockCodes.push("pairing_token_required");
  if (!input.staticPairingTokenDisabled) blockCodes.push("static_pairing_token_enabled");
  if (!input.threatModelReviewed) blockCodes.push("threat_model_review_required");
  if (!input.cryptographicReviewCompleted) blockCodes.push("cryptographic_review_required");
  if (!input.replayAndOrderingReviewCompleted) blockCodes.push("replay_review_required");
  if (!input.privacyReviewCompleted) blockCodes.push("privacy_review_required");
  if (!input.exportComplianceReviewed) blockCodes.push("export_review_required");
  if (!input.killSwitchEnabled) blockCodes.push("kill_switch_required");
  if (!input.keyStorageReviewed) blockCodes.push("key_storage_review_required");
  if (!input.interoperabilityReviewCompleted) blockCodes.push("interoperability_review_required");
  if (!input.revocationReviewCompleted) blockCodes.push("revocation_review_required");
  if (!input.physical4GReviewCompleted) blockCodes.push("physical_4g_review_required");
  if (!input.soak24HourReviewCompleted) blockCodes.push("soak_24_hour_review_required");
  if (
    !input.cryptographicProviderId ||
    !RELAY_AUDITED_CRYPTOGRAPHIC_PROVIDERS.includes(input.cryptographicProviderId)
  ) {
    blockCodes.push("cryptographic_provider_unapproved");
  }

  return {
    allowed: blockCodes.length === 0,
    state: blockCodes.length === 0 ? "ready" : "blocked",
    blockCodes,
  };
}

export type RelayFrameRejectionReason =
  | "invalid_frame_size"
  | "frame_too_large"
  | "invalid_buffer_size"
  | "buffer_limit_exceeded"
  | "invalid_sequence"
  | "sequence_exhausted"
  | "replay_or_out_of_order";

export type RelayFrameDecision =
  | { accepted: true; nextLastAcceptedSequence: bigint }
  | { accepted: false; reason: RelayFrameRejectionReason };

export function validateRelayFrame(input: {
  ciphertextByteLength: number;
  bufferedByteLength: number;
  lastAcceptedSequence?: bigint;
  sequence: bigint;
}): RelayFrameDecision {
  if (!Number.isSafeInteger(input.ciphertextByteLength) || input.ciphertextByteLength <= 0) {
    return { accepted: false, reason: "invalid_frame_size" };
  }
  if (input.ciphertextByteLength > RELAY_MAX_FRAME_BYTES) {
    return { accepted: false, reason: "frame_too_large" };
  }
  if (!Number.isSafeInteger(input.bufferedByteLength) || input.bufferedByteLength < 0) {
    return { accepted: false, reason: "invalid_buffer_size" };
  }
  if (input.bufferedByteLength + input.ciphertextByteLength > RELAY_MAX_BUFFERED_BYTES) {
    return { accepted: false, reason: "buffer_limit_exceeded" };
  }
  if (
    typeof input.sequence !== "bigint" ||
    input.sequence < 0n ||
    input.sequence > RELAY_MAX_SEQUENCE ||
    (input.lastAcceptedSequence !== undefined &&
      (typeof input.lastAcceptedSequence !== "bigint" ||
        input.lastAcceptedSequence < 0n ||
        input.lastAcceptedSequence > RELAY_MAX_SEQUENCE))
  ) {
    return { accepted: false, reason: "invalid_sequence" };
  }

  if (input.lastAcceptedSequence === RELAY_MAX_SEQUENCE) {
    return { accepted: false, reason: "sequence_exhausted" };
  }

  const expectedSequence = input.lastAcceptedSequence === undefined
    ? 0n
    : input.lastAcceptedSequence + 1n;
  if (input.sequence !== expectedSequence) {
    return { accepted: false, reason: "replay_or_out_of_order" };
  }

  return { accepted: true, nextLastAcceptedSequence: input.sequence };
}

export function relayReconnectDelaySeconds(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) && attempt >= 0
    ? Math.floor(attempt)
    : 0;
  const index = Math.min(normalizedAttempt, RELAY_RECONNECT_BACKOFF_SECONDS.length - 1);
  return RELAY_RECONNECT_BACKOFF_SECONDS[index] ?? RELAY_RECONNECT_BACKOFF_SECONDS[0];
}
