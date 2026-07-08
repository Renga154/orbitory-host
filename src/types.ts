/**
 * Shared protocol and domain types for the Orbitory host-agent.
 *
 * This module defines only data shapes (no behavior). It mirrors the
 * Orbitory wire protocol exactly: every message exchanged between a
 * client and this host-agent is an `Envelope<T>` whose `payload` shape
 * is determined by its `type` discriminant, as enumerated below in
 * `ClientMessage` and `ServerMessage`.
 */

import type { SandboxMode } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

/** A piece of user-facing text provided in both supported locales. */
export interface Localized {
  en: string;
  ja: string;
}

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------

/** The kind of machine/environment a host-agent instance runs on. */
export type HostType = "mac" | "linux" | "vps" | "devbox" | "cloud";

/** Connectivity status of a host as seen by the coordinating server. */
export type HostConnectionStatus = "online" | "offline" | "connecting";

/** The coding agent CLI/tool driving a given session. */
export type AgentType =
  | "claudeCode"
  | "codex"
  | "geminiCli"
  | "aider"
  | "openCode"
  | "custom";

/** Lifecycle status of an agent session. */
export type AgentStatus =
  | "planning"
  | "searching"
  | "editing"
  | "testing"
  | "stuck"
  | "approvalNeeded"
  | "completed"
  | "failed"
  | "idle";

/** Risk classification for an action awaiting human approval. */
export type RiskLevel = "low" | "medium" | "high";

/** The host-agent's suggested course of action for an approval request. */
export type Recommendation = "approve" | "reject" | "ask";

/** The human decision recorded for an approval request. */
export type ApprovalDecision = "approve" | "reject";

/** The kind of change made to a single file. */
export type FileChangeType = "added" | "modified" | "deleted";

/** Role of the author of a single chat message within a session. */
export type ChatRole = "user" | "assistant" | "system";

/**
 * Whether a session is driven by a real agent process (`"real"` — terminal /
 * stream providers) or a simulation (`"simulated"` — the mock provider and
 * seeded demo sessions). Stable English enum localized client-side
 * (docs/protocol.md §9); optional on the wire for backwards compatibility.
 */
export type SessionKind = "real" | "simulated";

/** Aggregate status of the test suite for a session. */
export type TestStatus = "notStarted" | "running" | "passed" | "failed";

/** The stream a line of terminal output was written to. */
export type TerminalStream = "stdout" | "stderr";

// ---------------------------------------------------------------------------
// Provider discovery (Phase 6) — sanitized, read-only descriptors
// ---------------------------------------------------------------------------

/**
 * Stable, client-localizable code explaining why a configured provider is not
 * startable. Codes (not host prose) so iOS localizes the UI. See
 * `docs/PHASE6_PROVIDER_MANAGEMENT_UI.md`.
 */
export type ProviderUnavailableReason =
  | "disabled"
  | "invalid_config"
  | "unsafe_working_directory"
  | "sandbox_required_but_unavailable"
  | "container_engine_unavailable"
  | "manual_only"
  | "unsupported_platform";

/**
 * Coarse, non-sensitive network summary for a provider. `not_applicable` when
 * the sandbox mode doesn't govern network at all (`none`/`restricted-process`).
 */
export type ProviderNetworkPolicy = "denied" | "allowed" | "not_applicable";

/**
 * A **sanitized** view of one host-configured provider, safe to send to the
 * (semi-trusted) iOS client. It carries only display/control metadata — never
 * `command`, `args`, `env`/`envAllowlist` values, `image`, `workingDirectory`,
 * absolute paths, usernames, tokens, or raw sandbox config. `sandboxMode` /
 * `networkPolicy` / `warnings` are summaries, not a config dump. The client can
 * only ever *start* a provider by its `id`; it can never define, edit, enable,
 * or configure one. See `docs/security.md` §5.
 */
export interface ProviderDescriptor {
  /** The `providerId` the client references in `session.start`. */
  id: string;
  /** Host-authored label. Never a path or username. */
  displayName: string;
  /** Host-authoritative agent type (localized client-side to "Claude Code", etc.). */
  agentType: AgentType;
  /** Whether the host config marks it `enabled: true`. */
  enabled: boolean;
  /** Whether it can actually be started right now (loaded + enabled + valid + sandbox enforceable). */
  startable: boolean;
  /** Why it can't be started; `null` iff `startable`. */
  unavailableReason: ProviderUnavailableReason | null;
  /** Requested sandbox mode (`none` when no sandbox block). */
  sandboxMode: SandboxMode;
  /** Whether the config requires the sandbox (fail-closed when unenforceable). */
  sandboxRequired: boolean;
  /** Whether the requested sandbox mode is enforceable on this host. */
  sandboxSupported: boolean;
  /** Coarse network summary (see `ProviderNetworkPolicy`). */
  networkPolicy: ProviderNetworkPolicy;
  /** Derived, coarse risk classification for the UI. */
  riskLevel: RiskLevel;
  /** Stable warning codes, localized client-side (e.g. `unsandboxed`, `network_allowed`). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Domain data shapes
// ---------------------------------------------------------------------------

/** Description of a machine that can run coding-agent sessions. */
export interface HostInfo {
  id: string;
  name: string;
  type: HostType;
  status: HostConnectionStatus;
  activeSessionCount: number;
  approvalWaitingCount: number;
  /** ISO 8601 UTC timestamp of the last time this host was seen. */
  lastSeenAt: string;
}

/** A single message in a session's chat transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
}

/** A request for human approval of a potentially risky agent action. */
export interface ApprovalRequest {
  approvalId: string;
  actionType: string;
  command: string;
  reason: Localized;
  riskLevel: RiskLevel;
  affectedFiles: string[];
  recommendation: Recommendation;
}

/** Aggregate result of running a session's test suite. */
export interface TestResult {
  status: TestStatus;
  passedCount: number;
  failedCount: number;
  durationSeconds: number;
  summary: Localized;
}

/** A single file changed by an agent session, with a human-readable diff summary. */
export interface ChangedFile {
  path: string;
  changeType: FileChangeType;
  summary: Localized;
  diffPreview: string;
}

/** The full state of a single coding-agent session. */
export interface AgentSession {
  id: string;
  hostId: string;
  title: string;
  agentType: AgentType;
  /** Optional (Phase 16). Absent ⇒ unknown; clients show no badge. */
  sessionKind?: SessionKind;
  status: AgentStatus;
  currentSummary: Localized;
  changedFileCount: number;
  changedFiles: ChangedFile[];
  testStatus: TestResult;
  approvalRequired: boolean;
  approvalRequest: ApprovalRequest | null;
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
  /** ISO 8601 UTC timestamp. */
  updatedAt: string;
  messages: ChatMessage[];
  logs: string[];
  diffSummary: Localized;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * The outer wrapper for every message exchanged over the Orbitory
 * WebSocket protocol, in both directions.
 */
export interface Envelope<T> {
  type: string;
  version: 1;
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  sessionId: string | null;
  payload: T;
}

// ---------------------------------------------------------------------------
// Client -> server payloads
// ---------------------------------------------------------------------------

export interface ClientHelloPayload {
  token?: string;
  /** Informational only (e.g. "Orbitory iOS") — never trusted for anything. */
  clientName?: string;
  clientVersion?: string;
  platform?: string;
}

export interface ChatMessagePayload {
  /**
   * Client-generated idempotency key (docs/protocol.md §7): resending the
   * same id for the same session after an uncertain send (e.g. reconnect)
   * is de-duplicated by `sessionStore` instead of appending twice.
   */
  messageId?: string;
  /**
   * Phase 16: `chat.message` is bidirectional. Client→server: optional,
   * implicitly `"user"` (clients never send another role). Server→client:
   * `"assistant"` or `"system"`.
   */
  role?: ChatRole;
  text: string;
}

/** How broadly the user's approval decision should apply. `"once"` applies
 * only to this specific approval request; `"always_this_session"` tells the
 * host-agent to auto-approve subsequent requests of the same `actionType`
 * for the remainder of this session (the host-agent decides whether to
 * honor that scope). */
export type ApprovalDecisionScope = "once" | "always_this_session";

export interface ApprovalDecisionPayload {
  approvalId: string;
  decision: ApprovalDecision;
  scope: ApprovalDecisionScope;
}

/** Why a client asked for a session to be stopped (docs/protocol.md §5). */
export type StopReason = "user_requested" | "timeout" | "error";

export interface SessionStopPayload {
  /**
   * Validated on receipt but not yet acted on beyond that — every stop
   * currently produces the same "Stopped by user." outcome. Differentiated
   * handling per reason is future work.
   */
  reason?: StopReason;
}

export interface SessionStartPayload {
  hostId: string;
  agentType: string;
  title: string;
  /**
   * Id of an already host-configured, `enabled` `TerminalAgentConfig` (see
   * `agentConfig.ts`) to drive this session with `TerminalAgentProvider`
   * instead of `MockAgentProvider`. Optional and additive — omitting it
   * preserves the original mock-only behavior. The client can only ever
   * reference an existing config entry by this id; it can never supply a
   * command or argument list itself.
   */
  providerId?: string;
  /**
   * Delivered as the session's first user chat message once the provider is
   * running (for a terminal-backed session: written to the child's stdin,
   * exactly like any other chat.message — data, never a command).
   */
  initialPrompt?: string;
}

export type SessionRequestSummaryPayload = Record<string, never>;

/** Client asks the server to (re-)send `providers.snapshot`. No fields. */
export type ProvidersRequestPayload = Record<string, never>;

// ---------------------------------------------------------------------------
// Client -> server messages (discriminated union)
// ---------------------------------------------------------------------------

export interface ClientHelloMessage extends Envelope<ClientHelloPayload> {
  type: "client.hello";
}

export interface ClientChatMessageMessage extends Envelope<ChatMessagePayload> {
  type: "chat.message";
  sessionId: string;
}

export interface ClientApprovalDecisionMessage
  extends Envelope<ApprovalDecisionPayload> {
  type: "approval.decision";
  sessionId: string;
}

export interface ClientSessionStopMessage extends Envelope<SessionStopPayload> {
  type: "session.stop";
  sessionId: string;
}

export interface ClientSessionStartMessage extends Envelope<SessionStartPayload> {
  type: "session.start";
}

export interface ClientSessionRequestSummaryMessage
  extends Envelope<SessionRequestSummaryPayload> {
  type: "session.request_summary";
  sessionId: string;
}

export interface ClientProvidersRequestMessage
  extends Envelope<ProvidersRequestPayload> {
  type: "providers.request";
  sessionId: null;
}

export interface ClientAuditRequestMessage extends Envelope<AuditRequestPayload> {
  type: "audit.request";
  sessionId: null;
}

/** Discriminated union of every message a client may send to the host-agent. */
export type ClientMessage =
  | ClientHelloMessage
  | ClientChatMessageMessage
  | ClientApprovalDecisionMessage
  | ClientSessionStopMessage
  | ClientSessionStartMessage
  | ClientSessionRequestSummaryMessage
  | ClientProvidersRequestMessage
  | ClientAuditRequestMessage;

// ---------------------------------------------------------------------------
// Server -> client payloads
// ---------------------------------------------------------------------------

export interface ServerHelloPayload {
  serverName: "orbitory-host-agent";
  serverVersion: string;
  protocolVersion: 1;
  hostId: string;
  capabilities: string[];
}

export interface SessionSnapshotPayload {
  hosts: HostInfo[];
  sessions: AgentSession[];
}

/** Sanitized list of host-configured providers (Phase 6). */
export interface ProvidersSnapshotPayload {
  providers: ProviderDescriptor[];
}

/**
 * Flat announcement of a brand-new session. Mirrors `AgentSession`'s
 * top-level scalar fields only (no `changedFiles`, `testStatus`,
 * `messages`, `logs`, `approvalRequest`, etc — those arrive later via
 * their own dedicated event types).
 */
export interface SessionCreatedPayload {
  id: string;
  hostId: string;
  title: string;
  agentType: AgentType;
  /** Optional (Phase 16). See `SessionKind`. */
  sessionKind?: SessionKind;
  status: AgentStatus;
  currentSummary: Localized;
  changedFileCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Flat partial patch of a session's top-level fields. Every field is
 * optional; a given emission should only include the fields that actually
 * changed at that call site. The client merges whatever is present into its
 * local copy of the session keyed by `sessionId`.
 */
export interface SessionUpdatedPayload {
  title?: string;
  status?: AgentStatus;
  currentSummary?: Localized;
  changedFileCount?: number;
  updatedAt?: string;
}

export interface AgentStatusChangedPayload {
  status: string;
  currentSummary: Localized;
}

export interface TerminalOutputPayload {
  stream: TerminalStream;
  text: string;
  /** Monotonically increasing integer per session, starting at 1. */
  sequence: number;
}

export interface ActivitySummaryUpdatedPayload {
  currentSummary: Localized;
}

export interface DiffUpdatedPayload {
  changedFileCount: number;
  changedFiles: ChangedFile[];
  diffSummary: Localized;
}

export interface TestsStartedPayload {
  testStatus: TestResult;
}

export interface TestsFinishedPayload {
  testStatus: TestResult;
}

export interface ApprovalRequiredPayload {
  approvalId: string;
  actionType: string;
  command: string;
  reason: Localized;
  riskLevel: RiskLevel;
  affectedFiles: string[];
  recommendation: Recommendation;
}

/** Who resolved an approval request. `"user"` — an explicit
 * `approval.decision` from the client; `"timeout"` — the Phase 16 approval
 * bridge denied a request nobody answered in time (fail closed);
 * `"system"` — the host-agent resolved it itself (an
 * `always_this_session` auto-approval, or a deny when the session
 * stopped with approvals still pending). */
export type ApprovalResolvedBy = "user" | "timeout" | "system";

export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  resolvedBy: ApprovalResolvedBy;
}

export interface SessionCompletedPayload {
  summary: Localized;
  changedFileCount: number;
  testStatus: TestResult;
}

export interface SessionFailedPayload {
  reason: Localized;
  changedFileCount: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Audit log (Phase 10)
// ---------------------------------------------------------------------------

/** Stable audit event type codes; the client localizes the display label. */
export type AuditEventType =
  | "session.started"
  | "session.stopped"
  | "session.completed"
  | "session.failed"
  | "provider.start.requested"
  | "provider.start.rejected"
  | "approval.required"
  | "approval.approved"
  | "approval.rejected"
  // Reserved (declared for forward-compat; NOT emitted by any Phase 10 hook —
  // there is no client→server "ask why" decision yet): "approval.asked_why",
  // "command.blocked", "system.warning". iOS decodes unknown types safely.
  | "approval.asked_why"
  | "approval.allow_similar"
  | "command.blocked"
  | "auth.failed"
  | "pairing.token.revoked"
  | "system.warning";

export type AuditSeverity = "info" | "warning" | "high" | "critical";

export type AuditActor = "user" | "agent" | "host" | "system";

/**
 * A single sanitized audit event (Phase 10). Host-authored operational metadata
 * ONLY — never raw secrets/tokens/keys/env values, provider config, command/args,
 * raw terminal output, or full diffs. `details` holds a small map of safe
 * primitives (counts, ids, risk levels, reason codes). See `docs/security.md` §8.
 */
export interface AuditEvent {
  id: string;
  version: number;
  timestamp: string;
  type: AuditEventType;
  severity: AuditSeverity;
  actor: AuditActor;
  hostId: string;
  sessionId: string | null;
  providerId: string | null;
  agentType: string | null;
  /** Optional host-authored bilingual copy; null → the client shows the type label. */
  summary: Localized | null;
  /** Small map of SAFE primitives only (no secrets, no free-form command/output). */
  details: Record<string, string | number | boolean> | null;
  /** `redacted` when a field was scrubbed or omitted for safety. */
  redactionState: "none" | "redacted";
  /** Ties related events together (e.g. an approvalId across required→resolved). */
  correlationId: string | null;
}

/** Server → client: recent audit events, sent after `session.snapshot` and on `audit.request`. */
export interface AuditSnapshotPayload {
  events: AuditEvent[];
}

/** Server → client: a single newly-recorded audit event. */
export interface AuditEventCreatedPayload {
  event: AuditEvent;
}

/** Client → server: ask the server to (re)send an `audit.snapshot`. No fields. */
export type AuditRequestPayload = Record<string, never>;

// ---------------------------------------------------------------------------
// Server -> client messages (discriminated union)
// ---------------------------------------------------------------------------

export interface ServerHelloMessage extends Envelope<ServerHelloPayload> {
  type: "server.hello";
  sessionId: null;
}

export interface ServerSessionSnapshotMessage
  extends Envelope<SessionSnapshotPayload> {
  type: "session.snapshot";
  sessionId: null;
}

export interface ServerProvidersSnapshotMessage
  extends Envelope<ProvidersSnapshotPayload> {
  type: "providers.snapshot";
  sessionId: null;
}

export interface ServerSessionCreatedMessage
  extends Envelope<SessionCreatedPayload> {
  type: "session.created";
  sessionId: string;
}

/**
 * Phase 16: server→client chat message — an `assistant` reply from a real
 * agent, or a `system` notice tied to the conversation. Same payload shape as
 * the client→server direction; `role` is required in practice here.
 */
export interface ServerChatMessageMessage extends Envelope<ChatMessagePayload> {
  type: "chat.message";
  sessionId: string;
}

export interface ServerSessionUpdatedMessage
  extends Envelope<SessionUpdatedPayload> {
  type: "session.updated";
  sessionId: string;
}

export interface ServerAgentStatusChangedMessage
  extends Envelope<AgentStatusChangedPayload> {
  type: "agent.status.changed";
  sessionId: string;
}

export interface ServerTerminalOutputMessage
  extends Envelope<TerminalOutputPayload> {
  type: "terminal.output";
  sessionId: string;
}

export interface ServerActivitySummaryUpdatedMessage
  extends Envelope<ActivitySummaryUpdatedPayload> {
  type: "activity.summary.updated";
  sessionId: string;
}

export interface ServerDiffUpdatedMessage extends Envelope<DiffUpdatedPayload> {
  type: "diff.updated";
  sessionId: string;
}

export interface ServerTestsStartedMessage extends Envelope<TestsStartedPayload> {
  type: "tests.started";
  sessionId: string;
}

export interface ServerTestsFinishedMessage
  extends Envelope<TestsFinishedPayload> {
  type: "tests.finished";
  sessionId: string;
}

export interface ServerApprovalRequiredMessage
  extends Envelope<ApprovalRequiredPayload> {
  type: "approval.required";
  sessionId: string;
}

export interface ServerApprovalResolvedMessage
  extends Envelope<ApprovalResolvedPayload> {
  type: "approval.resolved";
  sessionId: string;
}

export interface ServerSessionCompletedMessage
  extends Envelope<SessionCompletedPayload> {
  type: "session.completed";
  sessionId: string;
}

export interface ServerSessionFailedMessage
  extends Envelope<SessionFailedPayload> {
  type: "session.failed";
  sessionId: string;
}

export interface ServerErrorMessage extends Envelope<ErrorPayload> {
  type: "error";
  sessionId: string | null;
}

export interface ServerAuditSnapshotMessage extends Envelope<AuditSnapshotPayload> {
  type: "audit.snapshot";
  sessionId: null;
}

export interface ServerAuditEventCreatedMessage extends Envelope<AuditEventCreatedPayload> {
  type: "audit.event.created";
  sessionId: string | null;
}

/** Discriminated union of every message the host-agent may send to a client. */
export type ServerMessage =
  | ServerHelloMessage
  | ServerSessionSnapshotMessage
  | ServerProvidersSnapshotMessage
  | ServerSessionCreatedMessage
  | ServerChatMessageMessage
  | ServerSessionUpdatedMessage
  | ServerAgentStatusChangedMessage
  | ServerTerminalOutputMessage
  | ServerActivitySummaryUpdatedMessage
  | ServerDiffUpdatedMessage
  | ServerTestsStartedMessage
  | ServerTestsFinishedMessage
  | ServerApprovalRequiredMessage
  | ServerApprovalResolvedMessage
  | ServerSessionCompletedMessage
  | ServerSessionFailedMessage
  | ServerErrorMessage
  | ServerAuditSnapshotMessage
  | ServerAuditEventCreatedMessage;
