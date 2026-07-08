/**
 * Audit recording + integration (Phase 10).
 *
 * A module-level `AuditStore` singleton plus (a) helpers that record specific,
 * sanitized events from the approval / provider / session / security hook sites,
 * and (b) a derivation that maps the session/approval envelope stream to audit
 * events. Kept decoupled from `sessionStore` (no import) so the broadcast is
 * wired externally in `server.ts` — this avoids an import cycle and makes the
 * store trivially testable.
 *
 * SECURITY: every event here is HOST-AUTHORED safe metadata — never the raw
 * command, args, env, token, key, terminal output, or full file paths. Approval
 * events store counts/ids/risk, not the command or affected paths. See
 * `docs/security.md` §8.
 */

import * as os from "node:os";

import { AUDIT_LOG_PATH, AUDIT_MAX_EVENTS } from "./config.js";
import { AuditStore, FileAuditPersistence, type RecordAuditParams } from "./auditStore.js";
import type {
  ApprovalDecision,
  ApprovalResolvedBy,
  AuditEvent,
  Envelope,
  ProviderUnavailableReason,
  RiskLevel,
} from "./types.js";

/** Host identifier stamped on every audit event (informational, not a boundary). */
export const AUDIT_HOST_ID = os.hostname();

let store = new AuditStore({
  persistence: new FileAuditPersistence(AUDIT_LOG_PATH),
  max: AUDIT_MAX_EVENTS,
});

let broadcast: ((event: AuditEvent) => void) | null = null;

export function getAuditStore(): AuditStore {
  return store;
}

/** Test seam: swap the store (re-wires the current broadcast, if any). */
export function setAuditStoreForTests(next: AuditStore): void {
  store = next;
  if (broadcast) store.onRecorded(broadcast);
}

/** Wire live broadcasting of recorded events (server.ts → `sessionStore.emit`). */
export function setAuditBroadcast(cb: (event: AuditEvent) => void): void {
  broadcast = cb;
  store.onRecorded(cb);
}

export function recordAudit(params: RecordAuditParams): AuditEvent {
  return store.record(params);
}

function severityForRisk(risk: RiskLevel): "info" | "warning" | "high" {
  return risk === "high" ? "high" : risk === "medium" ? "warning" : "info";
}

/**
 * Coerce a possibly-untrusted agentType string to a known `AgentType`, mirroring
 * `sessionStore.coerceAgentType` (unknown → "custom"). A client's `session.start`
 * payload is only type-checked as a string before the audit hook runs; without this
 * an authenticated client could write an arbitrary string into an audit event's
 * `agentType` field. Kept inline so `audit.ts` stays decoupled from sessionStore.
 */
const KNOWN_AGENT_TYPES: readonly string[] = [
  "claudeCode",
  "codex",
  "geminiCli",
  "aider",
  "openCode",
  "custom",
];
function safeAgentType(raw: unknown): string {
  return typeof raw === "string" && KNOWN_AGENT_TYPES.includes(raw) ? raw : "custom";
}

function safeApprovalDecision(raw: unknown): ApprovalDecision {
  return raw === "approve" ? "approve" : "reject";
}

function safeApprovalResolvedBy(raw: unknown): ApprovalResolvedBy {
  return raw === "timeout" || raw === "system" || raw === "user" ? raw : "system";
}

// ---------------------------------------------------------------------------
// Explicit hook helpers (called from ws.ts / http.ts / CLI)
// ---------------------------------------------------------------------------

export function recordProviderStartRequested(providerId: string | undefined, agentType: string): void {
  recordAudit({
    type: "provider.start.requested",
    severity: "info",
    actor: "user",
    hostId: AUDIT_HOST_ID,
    providerId: providerId ?? null,
    // Coerce to a known AgentType — never store a raw client-supplied string.
    agentType: safeAgentType(agentType),
    summary: {
      en: providerId ? `Provider "${providerId}" start requested` : "Session start requested (mock)",
      ja: providerId ? `プロバイダー「${providerId}」の開始を要求` : "セッション開始を要求（モック）",
    },
  });
}

export function recordProviderStartRejected(
  providerId: string | undefined,
  reason: ProviderUnavailableReason | string,
): void {
  recordAudit({
    type: "provider.start.rejected",
    severity: "warning",
    actor: "host",
    hostId: AUDIT_HOST_ID,
    providerId: providerId ?? null,
    // Reason code only — never the hostile client fields, command, args, image, or env.
    details: { reason: String(reason) },
    summary: {
      en: `Provider start rejected (${reason})`,
      ja: `プロバイダーの開始が拒否されました（${reason}）`,
    },
  });
}

export function recordSessionStopRequested(sessionId: string): void {
  recordAudit({
    type: "session.stopped",
    severity: "info",
    actor: "user",
    hostId: AUDIT_HOST_ID,
    sessionId,
    summary: { en: "Stopped by user", ja: "ユーザーが停止しました" },
  });
}

export function recordAuthFailed(reason: string): void {
  recordAudit({
    type: "auth.failed",
    severity: "warning",
    actor: "system",
    hostId: AUDIT_HOST_ID,
    // Reason code only — never the presented token (even redacted) or headers.
    details: { reason },
    summary: { en: "Authentication failed", ja: "認証に失敗しました" },
  });
}

export function recordTokenRevoked(deviceId: string, deviceName: string): void {
  recordAudit({
    type: "pairing.token.revoked",
    severity: "high",
    actor: "user",
    hostId: AUDIT_HOST_ID,
    // Device id + name only — never a token or its hash.
    details: { deviceId, deviceName },
    summary: {
      en: `Paired-device token revoked (${deviceName})`,
      ja: `ペアリング済み端末トークンを無効化しました（${deviceName}）`,
    },
  });
}

// ---------------------------------------------------------------------------
// Envelope-stream derivation (session/approval lifecycle → audit)
// ---------------------------------------------------------------------------

/**
 * Derive + record an audit event from a broadcast server→client envelope, for
 * the lifecycle/approval events that flow through the session hub. Returns the
 * recorded event, or null for envelopes that aren't audited (most of them).
 * Never echoes raw command/output/paths — approval events store counts + risk.
 */
export function deriveAuditFromEnvelope(envelope: Envelope<unknown>): AuditEvent | null {
  const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : null;
  const p = (envelope.payload ?? {}) as Record<string, unknown>;

  switch (envelope.type) {
    case "session.created":
      return recordAudit({
        type: "session.started",
        severity: "info",
        actor: "agent",
        hostId: AUDIT_HOST_ID,
        sessionId,
        // Coerce to a known AgentType. The session `title` is deliberately NOT
        // copied: it is free-form client text (unlike counts/codes/ids), and the
        // audit log persists to disk — keep `details` to safe primitives only.
        agentType: p["agentType"] !== undefined ? safeAgentType(p["agentType"]) : null,
        details: null,
      });
    case "session.completed":
      return recordAudit({
        type: "session.completed",
        severity: "info",
        actor: "agent",
        hostId: AUDIT_HOST_ID,
        sessionId,
        details:
          typeof p["changedFileCount"] === "number"
            ? { changedFileCount: p["changedFileCount"] as number }
            : null,
      });
    case "session.failed":
      return recordAudit({
        type: "session.failed",
        severity: "warning",
        actor: "agent",
        hostId: AUDIT_HOST_ID,
        sessionId,
        // `reason` is host-authored Localized copy (safe).
        summary: isLocalized(p["reason"]) ? (p["reason"] as { en: string; ja: string }) : null,
        details:
          typeof p["changedFileCount"] === "number"
            ? { changedFileCount: p["changedFileCount"] as number }
            : null,
      });
    case "approval.required": {
      const risk = (typeof p["riskLevel"] === "string" ? p["riskLevel"] : "low") as RiskLevel;
      const affected = Array.isArray(p["affectedFiles"]) ? (p["affectedFiles"] as unknown[]).length : 0;
      return recordAudit({
        type: "approval.required",
        severity: severityForRisk(risk),
        actor: "agent",
        hostId: AUDIT_HOST_ID,
        sessionId,
        correlationId: typeof p["approvalId"] === "string" ? (p["approvalId"] as string) : null,
        summary: { en: "Approval required", ja: "承認が必要です" },
        // Counts + codes only — never the command or the affected paths themselves.
        details: {
          actionType: typeof p["actionType"] === "string" ? (p["actionType"] as string) : "unknown",
          riskLevel: risk,
          affectedFileCount: affected,
          recommendation:
            typeof p["recommendation"] === "string" ? (p["recommendation"] as string) : "ask",
        },
      });
    }
    case "approval.resolved": {
      const decision = safeApprovalDecision(p["decision"]);
      const resolvedBy = safeApprovalResolvedBy(p["resolvedBy"]);
      return recordAudit({
        type: decision === "approve" ? "approval.approved" : "approval.rejected",
        severity: decision === "reject" ? "warning" : "info",
        actor: resolvedBy === "user" ? "user" : "system",
        hostId: AUDIT_HOST_ID,
        sessionId,
        correlationId: typeof p["approvalId"] === "string" ? (p["approvalId"] as string) : null,
        summary:
          decision === "approve"
            ? { en: "Approval resolved: approved", ja: "承認結果: 承認" }
            : { en: "Approval resolved: rejected", ja: "承認結果: 拒否" },
        details: { decision, resolvedBy },
      });
    }
    default:
      return null;
  }
}

function isLocalized(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>)["en"] === "string" &&
    typeof (v as Record<string, unknown>)["ja"] === "string"
  );
}
