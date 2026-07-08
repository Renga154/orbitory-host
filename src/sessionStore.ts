/**
 * In-memory session store for the Orbitory host-agent.
 *
 * `sessionStore` is the single source of truth the rest of the host-agent
 * (see `http.ts` and `ws.ts`) reads from and dispatches into. It:
 *
 * - Owns the list of known `HostInfo` records and every `AgentSession`.
 * - Owns one `MockAgentProvider` per session (see
 *   `./providers/AgentProvider.ts`), wiring each provider's `streamEvents`
 *   output into its own `EventEmitter` so every envelope emitted anywhere
 *   ends up on the single `sessionStore.on("event", ...)` stream that
 *   `ws.ts` re-broadcasts verbatim to every connected client.
 * - Implements the handlers `ws.ts` calls in response to client->server
 *   protocol messages (`chat.message`, `approval.decision`, `session.stop`,
 *   `session.start`, `session.request_summary`).
 *
 * Seeding (Phase 16): at import time this module always registers ONE real
 * local host row (`os.hostname()`, the machine this host-agent is running
 * on). The small, believable fleet of fake hosts + simulated sessions that
 * used to be unconditional now seeds ONLY when `ORBITORY_DEMO_SESSIONS=true`
 * (see `config.ts`) — a fresh live connection shows the truth by default.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as os from "node:os";

import { agentConfigs, loadProviderDescriptors, type TerminalAgentConfig } from "./agentConfig.js";
import { DEMO_SESSIONS_ENABLED } from "./config.js";
import {
  APPROVAL_SCRIPTS,
  MockAgentProvider,
  nextApprovalId,
  TerminalAgentProvider,
  type AgentProvider,
  type MockScenario,
} from "./providers/AgentProvider.js";
import { ClaudeCodeStreamProvider } from "./providers/ClaudeCodeStreamProvider.js";
import type {
  AgentSession,
  AgentType,
  ApprovalDecision,
  ChangedFile,
  ChatMessage,
  HostInfo,
  Localized,
  ProviderDescriptor,
  ServerMessage,
  TestResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function passingTestResult(passedCount: number, durationSeconds: number): TestResult {
  return {
    status: "passed",
    passedCount,
    failedCount: 0,
    durationSeconds,
    summary: {
      en: `All ${passedCount} tests passed.`,
      ja: `${passedCount}件すべてのテストに合格しました。`,
    },
  };
}

function runningTestResult(): TestResult {
  return {
    status: "running",
    passedCount: 0,
    failedCount: 0,
    durationSeconds: 0,
    summary: { en: "Running test suite...", ja: "テストスイートを実行中です..." },
  };
}

function notStartedTestResult(): TestResult {
  return {
    status: "notStarted",
    passedCount: 0,
    failedCount: 0,
    durationSeconds: 0,
    summary: { en: "Not run yet.", ja: "まだ実行されていません。" },
  };
}

function chatMessage(role: ChatMessage["role"], text: string, minutesAgo: number): ChatMessage {
  return {
    id: `msg_${randomUUID()}`,
    role,
    text,
    timestamp: minutesAgoIso(minutesAgo),
  };
}

let sessionCounter = 0;
function nextSessionId(): string {
  sessionCounter += 1;
  return `session_${String(sessionCounter).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Seed data: hosts
// ---------------------------------------------------------------------------

const HOST_MAC = "host_mac_studio";
const HOST_VPS = "host_prod_vps";
const HOST_DEVBOX = "host_cloud_devbox";

/**
 * The ONE always-present host: the machine this host-agent process is
 * actually running on. `id`/`name` are `os.hostname()` (matching the
 * `hostId` `ws.ts` reports in `server.hello`). `type` is derived from
 * `process.platform` using only existing `HostType` values: darwin → "mac",
 * linux → "linux", anything else → "devbox" (the closest legal value for a
 * generic dev machine — there is deliberately no new enum member).
 */
function realLocalHost(): HostInfo {
  const platformType: HostInfo["type"] =
    process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "devbox";
  const hostname = os.hostname();
  return {
    id: hostname,
    name: hostname,
    type: platformType,
    status: "online",
    activeSessionCount: 0,
    approvalWaitingCount: 0,
    lastSeenAt: minutesAgoIso(0),
  };
}

/** The 3 FAKE demo hosts — seeded only with `ORBITORY_DEMO_SESSIONS=true`. */
function seedHosts(): HostInfo[] {
  return [
    {
      id: HOST_MAC,
      name: "Satoshi's Mac Studio",
      type: "mac",
      status: "online",
      activeSessionCount: 2,
      approvalWaitingCount: 1,
      lastSeenAt: minutesAgoIso(0),
    },
    {
      id: HOST_VPS,
      name: "prod-vps-01",
      type: "vps",
      status: "online",
      activeSessionCount: 1,
      approvalWaitingCount: 0,
      lastSeenAt: minutesAgoIso(0),
    },
    {
      id: HOST_DEVBOX,
      name: "cloud-devbox-01",
      type: "cloud",
      status: "offline",
      activeSessionCount: 0,
      approvalWaitingCount: 0,
      lastSeenAt: minutesAgoIso(47),
    },
  ];
}

// ---------------------------------------------------------------------------
// Seed data: sessions
// ---------------------------------------------------------------------------

/** Build the "approvalNeeded" seed session: mid-flow, waiting on `npm test`. */
function seedApprovalSession(): AgentSession {
  const id = nextSessionId();
  const approval = APPROVAL_SCRIPTS["auth"]!;
  const changedFiles: ChangedFile[] = [
    {
      path: "src/auth/session.ts",
      changeType: "modified",
      summary: {
        en: "Refresh the access token before it expires instead of after.",
        ja: "アクセストークンの有効期限が切れる前に更新するよう修正しました。",
      },
      diffPreview:
        "@@ -18,7 +18,10 @@\n-  if (isExpired(token)) {\n-    return refreshToken(token);\n-  }\n+  const expiresInMs = token.expiresAt - Date.now();\n+  if (expiresInMs < REFRESH_MARGIN_MS) {\n+    return refreshToken(token);\n+  }",
    },
    {
      path: "tests/auth.test.ts",
      changeType: "modified",
      summary: {
        en: "Add a test that asserts the token refreshes before expiry.",
        ja: "有効期限前にトークンが更新されることを検証するテストを追加しました。",
      },
      diffPreview:
        "@@ -40,6 +40,14 @@\n+  it('refreshes the token before it expires', async () => {\n+    const almostExpired = makeToken({ expiresInMs: 5_000 });\n+    const result = await ensureFreshToken(almostExpired);\n+    expect(result).not.toBe(almostExpired);\n+  });",
    },
  ];

  const summary: Localized = {
    en: `Waiting for approval to run "${approval.command}".`,
    ja: `"${approval.command}" の実行について承認を待っています。`,
  };

  return {
    id,
    hostId: HOST_MAC,
    title: "Fix early token-expiry bug in session refresh",
    agentType: "claudeCode",
    sessionKind: "simulated",
    status: "approvalNeeded",
    currentSummary: summary,
    changedFileCount: changedFiles.length,
    changedFiles,
    testStatus: notStartedTestResult(),
    approvalRequired: true,
    approvalRequest: {
      approvalId: nextApprovalId(),
      actionType: approval.actionType,
      command: approval.command,
      reason: approval.reason,
      riskLevel: approval.riskLevel,
      affectedFiles: approval.affectedFiles,
      recommendation: approval.recommendation,
    },
    createdAt: minutesAgoIso(18),
    updatedAt: minutesAgoIso(1),
    messages: [
      chatMessage(
        "user",
        "The access token keeps expiring mid-request in production. Can you make it refresh a bit earlier?",
        18,
      ),
      chatMessage(
        "assistant",
        "Found it — session.ts only refreshes after the token has already expired. I'll add a refresh margin and a regression test.",
        16,
      ),
    ],
    logs: [
      '$ rg -n "refreshToken" src/auth',
      "src/auth/session.ts:24:  return refreshToken(token);",
      "Opening src/auth/session.ts",
      "Applying edit to src/auth/session.ts",
      "Applying edit to tests/auth.test.ts",
    ],
    diffSummary: {
      en: "2 files changed.",
      ja: "2個のファイルが変更されました。",
    },
  };
}

/** Build the "testing" seed session: actively running tests after adding pagination. */
function seedTestingSession(): AgentSession {
  const id = nextSessionId();
  const changedFiles: ChangedFile[] = [
    {
      path: "src/api/routes.ts",
      changeType: "modified",
      summary: {
        en: "Add pagination params (limit/offset) to the /orders route.",
        ja: "/orders エンドポイントにページネーション用のパラメータ (limit/offset) を追加しました。",
      },
      diffPreview:
        "@@ -52,8 +52,13 @@\n-router.get('/orders', async (req, res) => {\n-  const orders = await db.orders.findAll();\n+router.get('/orders', async (req, res) => {\n+  const limit = clamp(Number(req.query.limit) || 20, 1, 100);\n+  const offset = Math.max(Number(req.query.offset) || 0, 0);\n+  const orders = await db.orders.findAll({ limit, offset });",
    },
    {
      path: "package.json",
      changeType: "modified",
      summary: {
        en: "Add zod as a dependency to validate the new query params.",
        ja: "新しいクエリパラメータを検証するため zod を依存関係に追加しました。",
      },
      diffPreview: '@@ -14,6 +14,7 @@\n   "dependencies": {\n+    "zod": "^3.24.1",',
    },
  ];

  return {
    id,
    hostId: HOST_VPS,
    title: "Add pagination to /orders API endpoint",
    agentType: "codex",
    sessionKind: "simulated",
    status: "testing",
    currentSummary: {
      en: "Running the test suite to check the change.",
      ja: "変更を確認するためテストスイートを実行しています。",
    },
    changedFileCount: changedFiles.length,
    changedFiles,
    testStatus: runningTestResult(),
    approvalRequired: false,
    approvalRequest: null,
    createdAt: minutesAgoIso(11),
    updatedAt: minutesAgoIso(0),
    messages: [
      chatMessage(
        "user",
        "Add pagination to the /orders API endpoint and update the tests.",
        11,
      ),
      chatMessage(
        "assistant",
        "On it — adding limit/offset query params to src/api/routes.ts, then I'll run the test suite.",
        10,
      ),
    ],
    logs: [
      "$ rg -n \"router.get('/orders'\" src/api/routes.ts",
      "src/api/routes.ts:52:router.get('/orders', async (req, res) => {",
      "Applying edit to src/api/routes.ts",
      "$ npm install zod --save",
      "added 1 package in 1.8s",
      "$ npm test",
      "> vitest run",
    ],
    diffSummary: {
      en: "2 files changed.",
      ja: "2個のファイルが変更されました。",
    },
  };
}

/** Build the "completed" seed session: the classic flaky-checkout-test fix, already shipped. */
function seedCompletedSession(): AgentSession {
  const id = nextSessionId();
  const changedFiles: ChangedFile[] = [
    {
      path: "tests/checkout_test.py",
      changeType: "modified",
      summary: {
        en: "Wait for the confirmation element before asserting visibility.",
        ja: "可視性をアサートする前に確認要素の描画を待機するよう修正しました。",
      },
      diffPreview:
        "@@ -42,6 +42,7 @@\n+    await page.wait_for_selector('.confirmation')\n     assert page.locator('.confirmation').is_visible()",
    },
    {
      path: "src/components/CheckoutConfirmation.tsx",
      changeType: "modified",
      summary: {
        en: "Fix render timing of the confirmation banner on order id change.",
        ja: "注文IDが変わった際の確認バナーの描画タイミングを修正しました。",
      },
      diffPreview:
        "@@ -18,7 +18,7 @@\n-  useEffect(() => setVisible(true), []);\n+  useEffect(() => { setVisible(true); }, [orderId]);",
    },
  ];
  const testStatus = passingTestResult(12, 45);

  return {
    id,
    hostId: HOST_DEVBOX,
    title: "Fix flaky checkout confirmation test",
    agentType: "aider",
    sessionKind: "simulated",
    status: "completed",
    currentSummary: {
      en: "Done. 2 files changed and all tests pass.",
      ja: "完了しました。2個のファイルを変更し、全テストに合格しています。",
    },
    changedFileCount: changedFiles.length,
    changedFiles,
    testStatus,
    approvalRequired: false,
    approvalRequest: null,
    createdAt: minutesAgoIso(90),
    updatedAt: minutesAgoIso(52),
    messages: [
      chatMessage("user", "checkout_test.py keeps failing intermittently on main. Can you fix it?", 90),
      chatMessage(
        "assistant",
        "Found a race condition — the confirmation banner wasn't waiting for the new order id before rendering. Fixed and pushed; all 12 tests pass now.",
        53,
      ),
    ],
    logs: [
      "$ pytest tests/checkout_test.py -k confirmation -v",
      "FAILED tests/checkout_test.py::test_confirmation_visible - race condition",
      "Applying edit to tests/checkout_test.py",
      "Applying edit to src/components/CheckoutConfirmation.tsx",
      "$ git push origin feature/fix-checkout-flake",
      "$ npm test",
      "✓ 12 passed (45s)",
    ],
    diffSummary: {
      en: "2 files changed.",
      ja: "2個のファイルが変更されました。",
    },
  };
}

/** Build the "stuck" seed session: needs the user's direction on how to proceed. */
function seedStuckSession(): AgentSession {
  const id = nextSessionId();
  const changedFiles: ChangedFile[] = [
    {
      path: "src/billing/invoice.ts",
      changeType: "modified",
      summary: {
        en: "Round invoice totals using banker's rounding instead of truncation.",
        ja: "請求合計の丸め処理を切り捨てから銀行丸めに変更しました。",
      },
      diffPreview:
        "@@ -30,7 +30,7 @@\n-  return Math.trunc(total * 100) / 100;\n+  return bankersRound(total, 2);",
    },
  ];

  return {
    id,
    hostId: HOST_MAC,
    title: "Investigate invoice rounding discrepancy",
    agentType: "geminiCli",
    sessionKind: "simulated",
    status: "stuck",
    currentSummary: {
      en: "Not sure how to proceed — two valid approaches conflict. Could you clarify which one to take?",
      ja: "この先どう進めるべきか判断がつきません。有効な2つの方針が競合しています。どちらを採用すべきか教えてください。",
    },
    changedFileCount: changedFiles.length,
    changedFiles,
    testStatus: notStartedTestResult(),
    approvalRequired: false,
    approvalRequest: null,
    createdAt: minutesAgoIso(35),
    updatedAt: minutesAgoIso(6),
    messages: [
      chatMessage(
        "user",
        "Customers are reporting invoice totals off by a cent on refunds. Can you look into it?",
        35,
      ),
      chatMessage(
        "assistant",
        "I found two ways to fix this: (1) switch invoice.ts to banker's rounding, or (2) keep truncation but " +
          "round at the line-item level instead of the total. Both work, but they have different tradeoffs " +
          "for existing invoices. Which approach would you like me to take?",
        6,
      ),
    ],
    logs: [
      "$ rg -n \"Math.trunc\" src/billing",
      "src/billing/invoice.ts:30:  return Math.trunc(total * 100) / 100;",
      "Applying edit to src/billing/invoice.ts",
    ],
    diffSummary: {
      en: "1 file changed.",
      ja: "1個のファイルが変更されました。",
    },
  };
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

const KNOWN_AGENT_TYPES: readonly AgentType[] = [
  "claudeCode",
  "codex",
  "geminiCli",
  "aider",
  "openCode",
  "custom",
];

function coerceAgentType(raw: string): AgentType {
  return (KNOWN_AGENT_TYPES as readonly string[]).includes(raw) ? (raw as AgentType) : "custom";
}

/**
 * The host-agent's single in-memory store of hosts and sessions, and the
 * single `EventEmitter` that every server->client envelope flows through on
 * its way out to connected WebSocket clients.
 *
 * Emits one event, `"event"`, whose listener receives a fully-formed
 * `ServerMessage` envelope ready to be JSON-serialized and sent verbatim.
 */
export class SessionStore extends EventEmitter {
  private readonly hosts = new Map<string, HostInfo>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly providers = new Map<string, AgentProvider>();
  /**
   * Client-supplied `chat.message.messageId` values already applied, keyed
   * per session, for the idempotent-resend behavior in docs/protocol.md §7.
   * In-memory only, like every other piece of session state — bounded by the
   * process's lifetime and the number of messages actually sent.
   */
  private readonly seenChatMessageIds = new Set<string>();

  constructor() {
    super();
    this.seed();
  }

  // -- Seeding --------------------------------------------------------------

  private seed(): void {
    // The real local host is ALWAYS present — a fresh live connection shows
    // the machine the host-agent actually runs on, with zero sessions.
    const localHost = realLocalHost();
    this.hosts.set(localHost.id, localHost);

    // The fake demo fleet is opt-in (Phase 16): screenshots/demos set
    // ORBITORY_DEMO_SESSIONS=true (as does `npm test`, whose suites exercise
    // the seeded mock lifecycle); production-honest defaults seed nothing.
    if (!DEMO_SESSIONS_ENABLED) {
      return;
    }

    for (const host of seedHosts()) {
      this.hosts.set(host.id, host);
    }

    const approvalSession = seedApprovalSession();
    const testingSession = seedTestingSession();
    const completedSession = seedCompletedSession();
    const stuckSession = seedStuckSession();

    this.registerSeededSession(approvalSession, "completes", "auth");
    this.registerSeededSession(testingSession, "completes", "api");
    this.registerSeededSession(completedSession, "completes", "checkout");
    this.registerSeededSession(stuckSession, "stuck", "billing");
  }

  private registerSeededSession(
    session: AgentSession,
    scenario: MockScenario,
    scriptKey: string,
  ): void {
    this.sessions.set(session.id, session);
    const provider = MockAgentProvider.forSeededSession(session, scenario, scriptKey);
    this.wireProvider(session.id, provider);
  }

  /** Subscribe to a provider's envelopes, forward them out, and keep our own session cache in sync. */
  private wireProvider(sessionId: string, provider: AgentProvider): void {
    this.providers.set(sessionId, provider);
    provider.streamEvents((envelope) => {
      this.absorb(envelope);
      this.emit("event", envelope);
    });
  }

  /**
   * Keep `this.sessions` (and host approval/active counters) in sync with
   * whatever a provider just emitted, so `getSessionsSnapshot()` /
   * `getSession()` always reflect the latest state without every caller
   * having to reach into a provider directly.
   */
  private absorb(envelope: ServerMessage): void {
    const sessionId = envelope.sessionId;
    if (!sessionId) {
      return;
    }

    // Every server->client event type that pertains to a session now carries
    // only a flat partial payload (or no session data at all), per
    // docs/protocol.md — none of them embed a full `AgentSession` anymore.
    // Rather than hand-merging every individual payload shape here, just
    // read the provider's authoritative current snapshot after each event.
    const provider = this.providers.get(sessionId);
    const latest = provider?.getStatus(sessionId);
    if (latest) {
      this.sessions.set(sessionId, latest);
      this.syncHostCounters();
    }
  }

  /** Recompute each host's `activeSessionCount`/`approvalWaitingCount` from current session state. */
  private syncHostCounters(): void {
    const active = new Map<string, number>();
    const waiting = new Map<string, number>();

    for (const session of this.sessions.values()) {
      const isActive =
        session.status !== "completed" && session.status !== "failed" && session.status !== "idle";
      if (isActive) {
        active.set(session.hostId, (active.get(session.hostId) ?? 0) + 1);
      }
      if (session.approvalRequired) {
        waiting.set(session.hostId, (waiting.get(session.hostId) ?? 0) + 1);
      }
    }

    for (const host of this.hosts.values()) {
      host.activeSessionCount = active.get(host.id) ?? 0;
      host.approvalWaitingCount = waiting.get(host.id) ?? 0;
    }
  }

  // -- Read APIs --------------------------------------------------------------

  getHosts(): HostInfo[] {
    return Array.from(this.hosts.values()).map((h) => ({ ...h }));
  }

  getSessionsSnapshot(): AgentSession[] {
    return Array.from(this.sessions.values()).map((s) => this.cloneSession(s));
  }

  /**
   * Sanitized, read-only descriptors of every host-configured provider (Phase
   * 6), for `GET /providers` and the `providers.snapshot` event. Derived from
   * the loaded allowlist (`agentConfigs`) plus the raw config file — never
   * exposing command/args/env/image/workingDirectory/paths. See
   * `agentConfig.ts` `loadProviderDescriptors` and `docs/security.md` §5.
   */
  getProviderDescriptors(): ProviderDescriptor[] {
    return loadProviderDescriptors();
  }

  getSession(id: string): AgentSession | undefined {
    const session = this.sessions.get(id);
    return session ? this.cloneSession(session) : undefined;
  }

  private cloneSession(session: AgentSession): AgentSession {
    return {
      ...session,
      currentSummary: { ...session.currentSummary },
      changedFiles: session.changedFiles.map((f) => ({ ...f, summary: { ...f.summary } })),
      testStatus: { ...session.testStatus, summary: { ...session.testStatus.summary } },
      approvalRequest: session.approvalRequest
        ? {
            ...session.approvalRequest,
            reason: { ...session.approvalRequest.reason },
            affectedFiles: [...session.approvalRequest.affectedFiles],
          }
        : null,
      messages: session.messages.map((m) => ({ ...m })),
      logs: [...session.logs],
      diffSummary: { ...session.diffSummary },
    };
  }

  // -- Write APIs (called by ws.ts in response to client messages) -----------

  /**
   * Forward a user chat message into the session's provider (mock: appends
   * it and schedules a scripted reply; terminal: appends it and writes the
   * text to the child process's stdin).
   *
   * When the client supplies a `messageId`, resending the same id for the
   * same session is an idempotent no-op per docs/protocol.md §7 — the
   * message is applied at most once, so a client that isn't sure whether a
   * send survived a reconnect can safely retry it.
   */
  handleChatMessage(sessionId: string, text: string, messageId?: string): void {
    const provider = this.providers.get(sessionId);
    if (!provider) {
      this.emitError(sessionId, "unknown_session", `No session found with id "${sessionId}".`);
      return;
    }

    if (messageId !== undefined) {
      const dedupeKey = `${sessionId}\u0000${messageId}`;
      if (this.seenChatMessageIds.has(dedupeKey)) {
        return;
      }
      this.seenChatMessageIds.add(dedupeKey);
    }

    void provider.sendMessage(sessionId, text);
  }

  /**
   * Resolve a pending approval by id: emit `approval.resolved`, then
   * continue that session's lifecycle forward (approve -> back to testing
   * -> completed; reject -> failed).
   *
   * `allowSimilarForSession` mirrors the client->server `approval.decision`
   * payload's `scope: "always_this_session"`. It is forwarded to the
   * session's provider: the Phase 16 Claude Code stream provider honors it only
   * for low-risk file-write approvals via its `ApprovalBroker`; the mock accepts
   * and ignores it — every future `approval.required` in a mock session is still
   * surfaced individually.
   */
  handleApprovalDecision(
    approvalId: string,
    decision: ApprovalDecision,
    allowSimilarForSession?: boolean,
  ): void {
    for (const [sessionId, provider] of this.providers) {
      const session = this.sessions.get(sessionId);
      if (session?.approvalRequest?.approvalId !== approvalId) {
        continue;
      }
      const resolved = provider.resolveApproval(approvalId, decision, allowSimilarForSession);
      if (!resolved) {
        this.emitError(
          sessionId,
          "approval_not_found",
          `Approval "${approvalId}" is no longer pending.`,
        );
      }
      return;
    }
    this.emitError(null, "approval_not_found", `No pending approval found with id "${approvalId}".`);
  }

  /**
   * Stop/interrupt a running session. Idempotent: stopping an
   * already-completed/failed session is a no-op, per `docs/protocol.md`'s
   * idempotency notes.
   */
  stopSession(sessionId: string): void {
    const provider = this.providers.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!provider || !session) {
      this.emitError(sessionId, "unknown_session", `No session found with id "${sessionId}".`);
      return;
    }
    if (session.status === "completed" || session.status === "failed") {
      return;
    }
    void provider.stopSession(sessionId);
  }

  /**
   * Create and seed a brand-new `AgentSession` in `"planning"`, emit
   * `session.created`, and begin its provider-driven lifecycle.
   *
   * When `providerId` is omitted, behavior is unchanged from before
   * `TerminalAgentProvider` existed: the session is driven by
   * `MockAgentProvider`. When `providerId` is present, it must match an
   * `enabled` entry in the host's `orbitory.config.json` allowlist (see
   * `agentConfig.ts`) — if it doesn't, the request is rejected with an
   * `error` envelope; it never silently falls back to mock, and the client
   * can never supply a command/args itself, only this lookup key.
   *
   * Returns `undefined` (after emitting a single `error` envelope) if
   * `hostId` doesn't refer to a known host, or `providerId` doesn't match
   * any configured+enabled terminal agent, rather than throwing — callers
   * such as `ws.ts` dispatch this from inside a broad try/catch that would
   * otherwise turn an intentionally-handled validation failure into a
   * second, redundant `internal_error` envelope.
   */
  startSession(
    hostId: string,
    agentType: string,
    title: string,
    providerId?: string,
    initialPrompt?: string,
  ): AgentSession | undefined {
    const host = this.hosts.get(hostId);
    if (!host) {
      this.emitError(null, "invalid_payload", `Unknown hostId "${hostId}".`);
      return undefined;
    }

    let terminalConfig: TerminalAgentConfig | undefined;
    if (providerId !== undefined) {
      terminalConfig = agentConfigs.get(providerId);
      if (!terminalConfig) {
        this.emitError(
          null,
          "invalid_payload",
          `Unknown or disabled providerId "${providerId}". Configure and enable it in orbitory.config.json first.`,
        );
        return undefined;
      }
    }

    const id = nextSessionId();
    const createdAt = nowIso();
    // For a terminal-backed session the host is authoritative about what kind
    // of agent it is (it configured the command), so the config's agentType
    // wins over the client-supplied hint. Mock sessions use the client hint.
    const resolvedAgentType = terminalConfig ? terminalConfig.agentType : coerceAgentType(agentType);
    const session: AgentSession = {
      id,
      hostId,
      title,
      agentType: resolvedAgentType,
      // Phase 16: terminal-backed sessions run a real process; providerId-less
      // starts are the mock simulation. Stable enum, localized client-side.
      sessionKind: terminalConfig ? "real" : "simulated",
      status: "planning",
      currentSummary: {
        en: "Starting up and reading the task description.",
        ja: "起動し、タスクの内容を読み込んでいます。",
      },
      changedFileCount: 0,
      changedFiles: [],
      testStatus: notStartedTestResult(),
      approvalRequired: false,
      approvalRequest: null,
      createdAt,
      updatedAt: createdAt,
      messages: [],
      logs: [],
      diffSummary: { en: "No files changed yet.", ja: "まだ変更されたファイルはありません。" },
    };

    this.sessions.set(id, session);
    this.syncHostCounters();

    this.emit("event", {
      type: "session.created",
      version: 1,
      timestamp: nowIso(),
      sessionId: id,
      payload: {
        id: session.id,
        hostId: session.hostId,
        title: session.title,
        agentType: session.agentType,
        sessionKind: session.sessionKind,
        status: session.status,
        currentSummary: { ...session.currentSummary },
        changedFileCount: session.changedFileCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    } satisfies ServerMessage);

    // Phase 16: a claudeCode entry with io "stream-json" gets the structured
    // stream provider (real status/chat/approvals); every other terminal
    // entry keeps the generic text path, byte-for-byte.
    const provider: AgentProvider = terminalConfig
      ? terminalConfig.io === "stream-json"
        ? ClaudeCodeStreamProvider.forNewSession(session, terminalConfig)
        : TerminalAgentProvider.forNewSession(session, terminalConfig)
      : MockAgentProvider.forNewSession(session, nextNewSessionScenario());
    this.wireProvider(id, provider);

    // docs/protocol.md §5: `initialPrompt` becomes the session's first user
    // chat message. For a terminal-backed session that means the provider
    // writes it to the (already spawned) child's stdin, exactly like any
    // other chat.message — data to the process, never a command.
    if (initialPrompt !== undefined && initialPrompt.trim().length > 0) {
      void provider.sendMessage(id, initialPrompt);
    }

    return this.cloneSession(session);
  }

  /** Emit an `activity.summary.updated` envelope on demand for a session. */
  requestSummary(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitError(sessionId, "unknown_session", `No session found with id "${sessionId}".`);
      return;
    }

    this.emit("event", {
      type: "activity.summary.updated",
      version: 1,
      timestamp: nowIso(),
      sessionId,
      payload: { currentSummary: { ...session.currentSummary } },
    } satisfies ServerMessage);
  }

  // -- Internal ---------------------------------------------------------------

  /**
   * Emit an `error` envelope. `recoverable` is derived from `code` per the
   * known-code table in `docs/protocol.md` section 7 ("Error handling") —
   * every code `sessionStore` emits today (`unknown_session`,
   * `approval_not_found`, `invalid_payload`) is documented there as
   * `recoverable: false` (retrying the same operation as-is will not help;
   * the caller needs to use a valid id/payload instead).
   */
  private emitError(sessionId: string | null, code: string, message: string): void {
    this.emit("event", {
      type: "error",
      version: 1,
      timestamp: nowIso(),
      sessionId,
      payload: { code, message, recoverable: false },
    } satisfies ServerMessage);
  }
}

/**
 * Rotate through scenarios for brand-new sessions created via
 * `session.start`, so repeatedly starting sessions in the mock doesn't
 * always produce the same outcome. Mostly "completes" (the common case),
 * occasionally "stuck" or "failed" so both alternate branches stay
 * reachable without needing a party trick to trigger them.
 */
const NEW_SESSION_SCENARIOS: readonly MockScenario[] = [
  "completes",
  "completes",
  "stuck",
  "completes",
  "failed",
];
let newSessionScenarioIndex = 0;
function nextNewSessionScenario(): MockScenario {
  const scenario = NEW_SESSION_SCENARIOS[newSessionScenarioIndex % NEW_SESSION_SCENARIOS.length]!;
  newSessionScenarioIndex += 1;
  return scenario;
}

/** The process-wide singleton every other host-agent module imports. */
export const sessionStore = new SessionStore();

export default sessionStore;
