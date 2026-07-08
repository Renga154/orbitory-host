/**
 * Approval bridge for real Claude Code sessions (Phase 16 —
 * `docs/PHASE16_REAL_AGENT_INTEGRATION.md` §4.3, Mechanism A).
 *
 * When Claude Code runs with `--permission-prompt-tool
 * mcp__orbitory__approval_prompt`, every permission request it would normally
 * ask its own terminal user is forwarded to Orbitory instead:
 *
 *   claude ──spawns──▶ scripts/orbitory-approval-bridge.js (MCP stdio server)
 *          tools/call ──▶ POST http://127.0.0.1:<port>/internal/approvals
 *                          (loopback-only + per-session bearer token)
 *          ──▶ ApprovalBroker.request() ──▶ approval.required on the phone
 *          ◀── approve / reject / timeout ◀── approval.decision (or nothing)
 *
 * Security invariants (see docs/security.md §4):
 * - The endpoint accepts loopback connections ONLY, and only with a valid
 *   per-session `ORBITORY_APPROVAL_BRIDGE_TOKEN` (random, generated at spawn,
 *   never logged, never in any client-bound envelope; it is NOT the pairing
 *   token, which stays stripped from every child environment).
 * - Timeout **denies** (fail closed): an unattended phone can never let an
 *   action through.
 * - The broker's emissions carry only the same sanitized `ApprovalRequest`
 *   fields the mock has always sent — command text is scrubbed, and the audit
 *   derivation (`src/audit.ts`) copies only counts/codes from them.
 */

import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { nextApprovalId } from "./providers/AgentProvider.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolvedPayload,
  Localized,
  RiskLevel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Permission → ApprovalRequest mapping (pure)
// ---------------------------------------------------------------------------

/** `ApprovalRequest` minus the broker-minted `approvalId`. */
export type PermissionApprovalFields = Omit<ApprovalRequest, "approvalId">;

/**
 * Bash commands considered destructive → `riskLevel: "high"`. Deliberately
 * conservative pattern matching: false positives cost one extra "ask", false
 * negatives under-warn a human — so when in doubt, patterns lean broad.
 */
export const DESTRUCTIVE_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf (any combined-flag order ending in f)
  /\brm\s+-[a-z]*f[a-z]*r\b/i, // rm -fr
  /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/,
  /\bsudo\b/,
  /\bcurl\b[^|\n]*\|\s*(ba|z)?sh\b/,
  /\bwget\b[^|\n]*\|\s*(ba|z)?sh\b/,
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
  /\b(shutdown|reboot|halt)\b/,
];

/** Tool-name → `actionType` table (open, additive enum per docs/protocol.md). */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Display cap for a derived command string inside an approval payload. */
const APPROVAL_COMMAND_MAX_CHARS = 300;

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [TRUNCATED]` : text;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Map a Claude Code permission request (tool name + input) to the sanitized
 * approval fields shown on the phone. Pure; `scrub` is applied to every
 * process/model-derived string (command text, paths, URLs) before it enters
 * the payload — host-authored template copy carries the bilingual reason.
 *
 * Risk table (conservative):
 * - Bash matching a destructive pattern → `high`
 * - any other Bash (including installs) → `medium`
 * - file writes (Write/Edit/MultiEdit/NotebookEdit) → `low`
 * - network tools (WebFetch/WebSearch) → `medium`
 * - anything else (`tool_use`) → `medium`
 *
 * `recommendation` is `approve` only for `low`; everything else is `ask`.
 */
export function mapPermissionToApproval(
  toolName: string,
  input: Record<string, unknown>,
  scrub: (text: string) => string,
): PermissionApprovalFields {
  const filePath = asString(input["file_path"]) || asString(input["notebook_path"]);
  const affectedFiles = filePath ? [capText(scrub(filePath), APPROVAL_COMMAND_MAX_CHARS)] : [];

  if (toolName === "Bash") {
    const rawCommand = asString(input["command"]);
    const command = capText(scrub(rawCommand), APPROVAL_COMMAND_MAX_CHARS);
    const destructive = DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(rawCommand));
    const riskLevel: RiskLevel = destructive ? "high" : "medium";
    return {
      actionType: "run_command",
      command,
      reason: {
        en: `Claude Code wants to run "${command}".`,
        ja: `Claude Code が「${command}」を実行しようとしています。`,
      },
      riskLevel,
      affectedFiles,
      recommendation: "ask",
    };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = affectedFiles[0] ?? "(unknown file)";
    return {
      actionType: "write_file",
      command: `${toolName} ${path}`,
      reason: {
        en: `Claude Code wants to write to ${path}.`,
        ja: `Claude Code が ${path} に書き込もうとしています。`,
      },
      riskLevel: "low",
      affectedFiles,
      recommendation: "approve",
    };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    const target = capText(scrub(asString(input["url"]) || asString(input["query"])), APPROVAL_COMMAND_MAX_CHARS);
    return {
      actionType: "network_request",
      command: target ? `${toolName} ${target}` : toolName,
      reason: {
        en: target
          ? `Claude Code wants to access the network: ${target}`
          : "Claude Code wants to access the network.",
        ja: target
          ? `Claude Code がネットワークにアクセスしようとしています: ${target}`
          : "Claude Code がネットワークにアクセスしようとしています。",
      },
      riskLevel: "medium",
      affectedFiles,
      recommendation: "ask",
    };
  }

  // Unknown/other tools (MCP tools, future built-ins): generic, conservative.
  const safeToolName = capText(scrub(toolName), APPROVAL_COMMAND_MAX_CHARS);
  return {
    actionType: "tool_use",
    command: safeToolName,
    reason: {
      en: `Claude Code wants to use the ${safeToolName} tool.`,
      ja: `Claude Code が ${safeToolName} ツールを使用しようとしています。`,
    },
    riskLevel: "medium",
    affectedFiles,
    recommendation: "ask",
  };
}

// ---------------------------------------------------------------------------
// ApprovalBroker
// ---------------------------------------------------------------------------

/** What the permission-prompt tool ultimately receives for one request. */
export interface ApprovalOutcome {
  behavior: "allow" | "deny";
  /** Required by Claude Code's contract when denying; shown to the model. */
  message?: string;
}

export interface ApprovalBrokerOptions {
  /** How long a request may stay pending before it is DENIED (fail closed). */
  timeoutMs: number;
  /** Scrubs process/model-derived text before it enters an approval payload. */
  scrub: (text: string) => string;
  /** Called (synchronously) when a new approval must be surfaced to the client. */
  onApprovalRequired: (request: ApprovalRequest) => void;
  /** Called (synchronously) when an approval settles, however it settles. */
  onApprovalResolved: (payload: ApprovalResolvedPayload) => void;
}

interface PendingApproval {
  fields: PermissionApprovalFields;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

const USER_DENY_MESSAGE = "The user rejected this action from Orbitory.";
const TIMEOUT_DENY_MESSAGE =
  "No approval decision arrived from Orbitory before the timeout; the action was denied (fail closed).";
export const DISPOSED_DENY_MESSAGE = "The Orbitory session ended before this action was reviewed; denied.";

function canAutoApproveSimilar(fields: PermissionApprovalFields): boolean {
  return fields.actionType === "write_file" && fields.riskLevel === "low" && fields.recommendation === "approve";
}

/**
 * Per-session approval state machine. One instance per
 * `ClaudeCodeStreamProvider` session:
 *
 * - `request()` surfaces an `approval.required` and returns a promise the
 *   loopback endpoint (and therefore the blocked `claude` permission call)
 *   awaits.
 * - `resolveApproval()` is the provider's `resolveApproval` implementation —
 *   the user's `approval.decision` settles the promise. With
 *   `allowSimilar: true` on a low-risk file-write approval, the `actionType`
 *   is remembered and later low-risk file writes auto-allow (still emitting
 *   `approval.required` + an immediate `approval.resolved` with
 *   `resolvedBy: "system"`, so the timeline and audit log stay truthful).
 *   Medium/high/coarse actions (`run_command`, `network_request`, `tool_use`)
 *   always require a fresh approval even if the client asked for similar scope.
 * - The timeout denies with `resolvedBy: "timeout"`; `disposeAll()` (session
 *   stop/exit) denies everything still pending with `resolvedBy: "system"`.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly allowedActionTypes = new Set<string>();

  constructor(private readonly options: ApprovalBrokerOptions) {}

  request(toolName: string, input: Record<string, unknown>): Promise<ApprovalOutcome> {
    const fields = mapPermissionToApproval(toolName, input, this.options.scrub);
    const approvalId = nextApprovalId();
    const request: ApprovalRequest = { approvalId, ...fields };

    if (canAutoApproveSimilar(fields) && this.allowedActionTypes.has(fields.actionType)) {
      // Auto-allowed repeat ("always_this_session"): the timeline still shows
      // the request AND that the system resolved it — never an invisible allow.
      this.options.onApprovalRequired(request);
      this.options.onApprovalResolved({ approvalId, decision: "approve", resolvedBy: "system" });
      return Promise.resolve({ behavior: "allow" });
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(approvalId)) return;
        this.options.onApprovalResolved({ approvalId, decision: "reject", resolvedBy: "timeout" });
        resolve({ behavior: "deny", message: TIMEOUT_DENY_MESSAGE });
      }, this.options.timeoutMs);
      // Never keep the host-agent process alive just for a pending approval.
      timer.unref?.();

      this.pending.set(approvalId, { fields, resolve, timer });
      this.options.onApprovalRequired(request);
    });
  }

  /**
   * Settle a pending approval with the user's decision. Returns `false` when
   * `approvalId` isn't pending here (mirrors `AgentProvider.resolveApproval`).
   */
  resolveApproval(approvalId: string, decision: ApprovalDecision, allowSimilar = false): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);

    if (decision === "approve" && allowSimilar && canAutoApproveSimilar(entry.fields)) {
      this.allowedActionTypes.add(entry.fields.actionType);
    }

    this.options.onApprovalResolved({ approvalId, decision, resolvedBy: "user" });
    entry.resolve(
      decision === "approve" ? { behavior: "allow" } : { behavior: "deny", message: USER_DENY_MESSAGE },
    );
    return true;
  }

  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Deny every still-pending approval (session stop/exit). Fail closed. */
  disposeAll(): void {
    for (const [approvalId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.options.onApprovalResolved({ approvalId, decision: "reject", resolvedBy: "system" });
      entry.resolve({ behavior: "deny", message: DISPOSED_DENY_MESSAGE });
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Loopback HTTP endpoint (POST /internal/approvals)
// ---------------------------------------------------------------------------

/** Mint a fresh per-session bridge token. Never logged, never sent to clients. */
export function generateBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The loopback base URL where `/internal/approvals` is actually reachable.
 * Set once by whoever calls `listen()` (src/index.ts, and the test server
 * helper) because the bound port is only known then — the config PORT can be
 * 0/overridden. `null` until a server is listening.
 *
 * NOTE: under `ORBITORY_TLS_ENABLED` this is an `https://127.0.0.1:…` URL
 * with a self-signed cert the bridge script does not trust, so every
 * permission request DENIES (fail closed) rather than silently skipping the
 * phone. Plaintext-loopback bridging under TLS is follow-up work; the
 * limitation is documented in `docs/PHASE16_REAL_AGENT_INTEGRATION.md`'s
 * checkpoint notes rather than papered over with disabled TLS verification.
 */
let internalApprovalBaseUrl: string | null = null;

export function setInternalApprovalBaseUrl(baseUrl: string): void {
  internalApprovalBaseUrl = baseUrl.replace(/\/$/, "");
}

/** Full URL for the bridge env var, or null when no server is listening yet. */
export function getInternalApprovalUrl(): string | null {
  return internalApprovalBaseUrl === null ? null : `${internalApprovalBaseUrl}/internal/approvals`;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** What a provider registers so the endpoint can route a request to its broker. */
export interface ApprovalBridgeRegistration {
  sessionId: string;
  /** The per-session `ORBITORY_APPROVAL_BRIDGE_TOKEN` value. */
  token: string;
  handle: (params: {
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  }) => Promise<ApprovalOutcome>;
}

/** Active registrations, keyed by bridge token. Module-level: the endpoint is
 * registered per Fastify instance but sessions are process-wide. */
const activeBridges = new Map<string, ApprovalBridgeRegistration>();

/** Register a session's bridge; returns the matching unregister function. */
export function registerApprovalBridge(registration: ApprovalBridgeRegistration): () => void {
  activeBridges.set(registration.token, registration);
  return () => {
    activeBridges.delete(registration.token);
  };
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

/**
 * Register `POST /internal/approvals` — the loopback-only endpoint the MCP
 * bridge script (`scripts/orbitory-approval-bridge.js`, spawned by `claude`)
 * posts permission requests to.
 *
 * - Non-loopback remote address → 403 (this endpoint is for same-host
 *   children only; it is NOT part of the client protocol).
 * - Missing/unknown bearer token → 401. The token is the per-session
 *   `ORBITORY_APPROVAL_BRIDGE_TOKEN`; it is never logged (the request
 *   serializer emits no headers, and pino additionally redacts
 *   `req.headers.authorization` — see `server.ts`).
 * - Handler errors → `{ behavior: "deny" }` (fail closed), never a 5xx that
 *   the CLI might treat ambiguously.
 */
export function registerInternalApprovalRoute(app: FastifyInstance): void {
  app.post("/internal/approvals", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      reply.code(403);
      return { error: "forbidden" };
    }

    const token = extractBearerToken(request);
    const registration = token !== undefined ? activeBridges.get(token) : undefined;
    if (!registration) {
      reply.code(401);
      return { error: "unauthorized" };
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const toolName = body["toolName"];
    if (typeof toolName !== "string" || toolName.length === 0) {
      reply.code(400);
      return { error: "invalid_payload" };
    }
    const input =
      typeof body["input"] === "object" && body["input"] !== null && !Array.isArray(body["input"])
        ? (body["input"] as Record<string, unknown>)
        : {};
    const toolUseId = typeof body["toolUseId"] === "string" ? body["toolUseId"] : undefined;

    try {
      const outcome = await registration.handle({
        toolName,
        input,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      });
      if (outcome.behavior === "allow") {
        // Claude Code's permission-prompt contract expects `updatedInput` on
        // allow; we pass the input through unmodified.
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: outcome.message ?? USER_DENY_MESSAGE };
    } catch {
      // Fail closed: any internal error denies the action.
      return { behavior: "deny", message: "Orbitory approval bridge error; the action was denied." };
    }
  });
}

/** Bilingual copy for the status shown while an approval is pending. */
export function approvalPendingSummary(command: string): Localized {
  return {
    en: `Waiting for approval to run "${command}".`,
    ja: `"${command}" の実行について承認を待っています。`,
  };
}
