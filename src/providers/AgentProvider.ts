/**
 * Agent providers for the Orbitory host-agent.
 *
 * An `AgentProvider` is the thing that actually drives a single coding-agent
 * session's lifecycle and produces the server->client protocol envelopes
 * (see `docs/protocol.md` and `../types.ts`) that describe what it's doing.
 * `sessionStore` (see `../sessionStore.ts`) is the only consumer of this
 * module: it creates one provider per session, subscribes to it via
 * `streamEvents`, and re-broadcasts every envelope the provider emits to all
 * connected WebSocket clients, tagging nothing extra — providers already
 * stamp `sessionId` on every envelope they produce.
 *
 * Two implementations live here:
 *
 * - `MockAgentProvider` — a fully working, self-contained simulation. It owns
 *   an in-memory `AgentSession`, advances it through a believable scripted
 *   lifecycle on `setTimeout` timers (seconds, not minutes), and emits
 *   protocol-shaped envelopes as it goes. This is what powers the entire MVP.
 * - `TerminalAgentProvider` (Alpha) — spawns a *host-configured* command
 *   (see `../agentConfig.ts`) via `child_process.spawn` (never a shell —
 *   `command`/`args` are passed as an argv array, so shell metacharacters in
 *   a configured arg can't do anything unexpected), streams its stdout/
 *   stderr as `terminal.output`, maps process start/activity/exit onto
 *   Orbitory session statuses, and forwards `chat.message` text to the
 *   child's stdin. See the class-level comment below for the exact design
 *   and `docs/security.md` for the full threat model.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { TerminalAgentConfig } from "../agentConfig.js";
import { PAIRING_TOKEN } from "../config.js";
import { scrubSecrets, StreamScrubber } from "../scrubbing.js";
import { describeSandbox, ENV_NAME_PATTERN, wrapCommandForSandbox } from "../sandbox.js";
import { presetCopy, type AgentPresetCopy } from "./agentPresets.js";
import type {
  AgentSession,
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  ChangedFile,
  ChatMessage,
  Localized,
  ServerMessage,
  TestResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Provider-facing types
// ---------------------------------------------------------------------------

/** Options accepted when asking a provider to start a brand-new session. */
export interface StartSessionOptions {
  /** Id of the already-created `AgentSession` this provider should drive. */
  sessionId: string;
  hostId: string;
  title: string;
  agentType: AgentSession["agentType"];
  /**
   * Which scripted path the mock should follow. Only meaningful for
   * `MockAgentProvider`; ignored by `TerminalAgentProvider`.
   * Defaults to `"completes"` when omitted.
   */
  scenario?: MockScenario;
}

/**
 * A single server->client message, fully formed and ready to broadcast.
 * This is just `ServerMessage` from `../types.ts` under a shorter local
 * alias so provider code reads a little less noisily.
 */
export type OutboundEnvelope = ServerMessage;

/**
 * Common surface every agent provider implementation must satisfy,
 * regardless of whether it's simulated or backed by a real process.
 */
export interface AgentProvider {
  /** Stable machine-readable identifier for this provider implementation. */
  id: string;
  /** Human-readable name, e.g. for logs/diagnostics. */
  displayName: string;

  /** Begin driving a new session's lifecycle. Resolves once it has been created. */
  startSession(opts: StartSessionOptions): Promise<AgentSession>;

  /** Forward a chat message from the user into the running session. */
  sendMessage(sessionId: string, text: string): Promise<void>;

  /** Stop/interrupt a running session. */
  stopSession(sessionId: string): Promise<void>;

  /** Synchronously read the current state of a session, if known to this provider. */
  getStatus(sessionId: string): AgentSession | undefined;

  /**
   * Subscribe to every envelope this provider emits for every session it
   * drives. There is no unsubscribe — providers in this codebase live for
   * the lifetime of the process, and `sessionStore` is their only
   * subscriber.
   */
  streamEvents(onEvent: (envelope: OutboundEnvelope) => void): void;

  /**
   * Resolve a pending approval this provider raised, identified by
   * `approvalId`. Returns `false` (a no-op) if this provider has no
   * matching pending approval for that id — `sessionStore` calls this on
   * every provider in turn until one returns `true`. Providers that never
   * raise approvals (e.g. `TerminalAgentProvider` Alpha) can simply always
   * return `false`.
   *
   * `allowSimilar` (Phase 16) mirrors the client's `approval.decision`
   * `scope: "always_this_session"`: providers that support it (the Claude
   * Code stream provider's `ApprovalBroker`) auto-approve later requests of
   * the same `actionType` for the rest of the session; others may ignore it.
   */
  resolveApproval(approvalId: string, decision: ApprovalDecision, allowSimilar?: boolean): boolean;
}

// ---------------------------------------------------------------------------
// MockAgentProvider
// ---------------------------------------------------------------------------

/** Which scripted lifecycle a mock session should follow. */
export type MockScenario = "completes" | "stuck" | "failed";

const TICK_MS = {
  /** Small pause used between individual `terminal.output` lines. */
  outputLine: 650,
  /** Planning phase duration before moving to searching. */
  planning: 2200,
  /** Searching phase duration before moving to editing. */
  searching: 2600,
  /** Editing phase duration before moving to testing/approval. */
  editing: 3200,
  /** How long a test run takes to "finish". */
  testing: 2400,
  /** Delay before the assistant "replies" to an incoming chat message. */
  chatReply: 1400,
} as const;

let approvalCounter = 0;
/**
 * Mint a globally-unique approval id. Exported so `sessionStore` can use the
 * same counter when seeding sessions that start out already
 * `approvalNeeded`, keeping every approval id unique across every session
 * rather than each call site inventing its own numbering scheme.
 */
export function nextApprovalId(): string {
  approvalCounter += 1;
  return `approval_${String(approvalCounter).padStart(4, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a fully-formed, protocol-shaped server->client envelope. `type` is
 * constrained to `ServerMessage["type"]` and `payload` to that message's
 * matching payload shape, so a typo'd `type` or mismatched `payload` is a
 * compile error rather than a runtime surprise. Exported (Phase 16) so
 * `ClaudeCodeStreamProvider` builds envelopes through the exact same helper.
 */
export function envelope<T extends ServerMessage["type"]>(
  type: T,
  sessionId: string | null,
  payload: Extract<ServerMessage, { type: T }>["payload"],
): Extract<ServerMessage, { type: T }> {
  return {
    type,
    version: 1,
    timestamp: nowIso(),
    sessionId,
    payload,
  } as Extract<ServerMessage, { type: T }>;
}

function emptyTestResult(): TestResult {
  return {
    status: "notStarted",
    passedCount: 0,
    failedCount: 0,
    durationSeconds: 0,
    summary: { en: "Not run yet.", ja: "まだ実行されていません。" },
  };
}

/**
 * A believable "editing pass": a small script of files a mock session might
 * touch, paired with realistic bilingual summaries and diff previews. Each
 * scenario/session walks through a subset of these in order.
 */
interface EditStep {
  path: string;
  changeType: ChangedFile["changeType"];
  summary: Localized;
  diffPreview: string;
  /** Bilingual narration emitted as `activity.summary.updated` while this file is being worked on. */
  activity: Localized;
  /** A couple of realistic terminal lines to emit while "working" on this file. */
  terminalLines: string[];
}

const EDIT_SCRIPTS: Record<string, EditStep[]> = {
  auth: [
    {
      path: "src/auth/session.ts",
      changeType: "modified",
      summary: {
        en: "Refresh the access token before it expires instead of after.",
        ja: "アクセストークンの有効期限が切れる前に更新するよう修正しました。",
      },
      diffPreview:
        "@@ -18,7 +18,10 @@\n-  if (isExpired(token)) {\n-    return refreshToken(token);\n-  }\n+  const expiresInMs = token.expiresAt - Date.now();\n+  if (expiresInMs < REFRESH_MARGIN_MS) {\n+    return refreshToken(token);\n+  }",
      activity: {
        en: "Reading src/auth/session.ts to find the token refresh logic.",
        ja: "src/auth/session.ts を読み込み、トークン更新処理を確認しています。",
      },
      terminalLines: [
        "$ rg -n \"refreshToken\" src/auth",
        "src/auth/session.ts:24:  return refreshToken(token);",
        "Opening src/auth/session.ts",
      ],
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
      activity: {
        en: "Adding a regression test to tests/auth.test.ts for the early-refresh window.",
        ja: "早期更新のタイミングを検証する回帰テストを tests/auth.test.ts に追加しています。",
      },
      terminalLines: [
        "$ ls tests | grep auth",
        "auth.test.ts",
        "Writing new test case: refreshes the token before it expires",
      ],
    },
  ],
  api: [
    {
      path: "src/api/routes.ts",
      changeType: "modified",
      summary: {
        en: "Add pagination params (limit/offset) to the /orders route.",
        ja: "/orders エンドポイントにページネーション用のパラメータ (limit/offset) を追加しました。",
      },
      diffPreview:
        "@@ -52,8 +52,13 @@\n-router.get('/orders', async (req, res) => {\n-  const orders = await db.orders.findAll();\n+router.get('/orders', async (req, res) => {\n+  const limit = clamp(Number(req.query.limit) || 20, 1, 100);\n+  const offset = Math.max(Number(req.query.offset) || 0, 0);\n+  const orders = await db.orders.findAll({ limit, offset });",
      activity: {
        en: "Editing src/api/routes.ts to add limit/offset query params to /orders.",
        ja: "src/api/routes.ts を編集し、/orders に limit/offset クエリパラメータを追加しています。",
      },
      terminalLines: [
        "$ rg -n \"router.get\\('/orders'\" src/api/routes.ts",
        "src/api/routes.ts:52:router.get('/orders', async (req, res) => {",
        "Applying edit to src/api/routes.ts",
      ],
    },
    {
      path: "package.json",
      changeType: "modified",
      summary: {
        en: "Add zod as a dependency to validate the new query params.",
        ja: "新しいクエリパラメータを検証するため zod を依存関係に追加しました。",
      },
      diffPreview:
        '@@ -14,6 +14,7 @@\n   "dependencies": {\n+    "zod": "^3.24.1",',
      activity: {
        en: "Updating package.json to add zod for query param validation.",
        ja: "クエリパラメータ検証のため package.json に zod を追加しています。",
      },
      terminalLines: ["$ npm install zod --save", "added 1 package in 1.8s"],
    },
  ],
  checkout: [
    {
      path: "tests/checkout_test.py",
      changeType: "modified",
      summary: {
        en: "Wait for the confirmation element before asserting visibility.",
        ja: "可視性をアサートする前に確認要素の描画を待機するよう修正しました。",
      },
      diffPreview:
        "@@ -42,6 +42,7 @@\n+    await page.wait_for_selector('.confirmation')\n     assert page.locator('.confirmation').is_visible()",
      activity: {
        en: "Investigating the flaky checkout_test.py race condition.",
        ja: "checkout_test.py で発生している不安定なレースコンディションを調査しています。",
      },
      terminalLines: [
        "$ pytest tests/checkout_test.py -k confirmation -v",
        "FAILED tests/checkout_test.py::test_confirmation_visible - race condition",
      ],
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
      activity: {
        en: "Fixing CheckoutConfirmation.tsx so the banner re-renders on new orders.",
        ja: "新しい注文でバナーが再描画されるよう CheckoutConfirmation.tsx を修正しています。",
      },
      terminalLines: [
        "$ rg -n \"useEffect\" src/components/CheckoutConfirmation.tsx",
        "src/components/CheckoutConfirmation.tsx:18:  useEffect(() => setVisible(true), []);",
      ],
    },
  ],
  billing: [
    {
      path: "src/billing/invoice.ts",
      changeType: "modified",
      summary: {
        en: "Round invoice totals using banker's rounding instead of truncation.",
        ja: "請求合計の丸め処理を切り捨てから銀行丸めに変更しました。",
      },
      diffPreview:
        "@@ -30,7 +30,7 @@\n-  return Math.trunc(total * 100) / 100;\n+  return bankersRound(total, 2);",
      activity: {
        en: "Reading src/billing/invoice.ts to locate the rounding bug.",
        ja: "src/billing/invoice.ts を読み込み、丸め処理のバグ箇所を特定しています。",
      },
      terminalLines: [
        "$ rg -n \"Math.trunc\" src/billing",
        "src/billing/invoice.ts:30:  return Math.trunc(total * 100) / 100;",
      ],
    },
  ],
};

/** Realistic approval scenarios, keyed by the same script name as `EDIT_SCRIPTS`. */
interface ApprovalScript {
  actionType: string;
  command: string;
  reason: Localized;
  riskLevel: ApprovalRequest["riskLevel"];
  affectedFiles: string[];
  recommendation: ApprovalRequest["recommendation"];
}

const APPROVAL_SCRIPTS: Record<string, ApprovalScript> = {
  auth: {
    actionType: "run_command",
    command: "npm test",
    reason: {
      en: "Run the full test suite to confirm the token refresh fix doesn't break other auth flows.",
      ja: "トークン更新の修正が他の認証フローに影響しないか確認するため、テストスイート全体を実行します。",
    },
    riskLevel: "low",
    affectedFiles: ["src/auth/session.ts", "tests/auth.test.ts"],
    recommendation: "approve",
  },
  api: {
    actionType: "install_dependency",
    command: "npm install",
    reason: {
      en: "Install the newly added zod dependency before running tests.",
      ja: "テスト実行前に、新しく追加した zod の依存関係をインストールする必要があります。",
    },
    riskLevel: "medium",
    affectedFiles: ["package.json", "package-lock.json"],
    recommendation: "approve",
  },
  checkout: {
    actionType: "git_push",
    command: "git push origin feature/fix-checkout-flake",
    reason: {
      en: "Push the fix branch so the PR can be opened and reviewed.",
      ja: "PRを作成しレビューできるよう、修正ブランチをプッシュします。",
    },
    riskLevel: "medium",
    affectedFiles: ["tests/checkout_test.py", "src/components/CheckoutConfirmation.tsx"],
    recommendation: "approve",
  },
  billing: {
    actionType: "run_command",
    command: "npm test",
    reason: {
      en: "Re-run the billing test suite after changing the rounding strategy.",
      ja: "丸め処理のロジックを変更したため、請求関連のテストスイートを再実行します。",
    },
    riskLevel: "low",
    affectedFiles: ["src/billing/invoice.ts"],
    recommendation: "approve",
  },
};

/** Order in which script keys are picked for successive sessions, so seeded data varies. */
const SCRIPT_ROTATION = ["auth", "api", "checkout", "billing"] as const;
let scriptRotationIndex = 0;
function nextScriptKey(): (typeof SCRIPT_ROTATION)[number] {
  const key = SCRIPT_ROTATION[scriptRotationIndex % SCRIPT_ROTATION.length]!;
  scriptRotationIndex += 1;
  return key;
}

/**
 * Drives a single `AgentSession` through a realistic, scripted lifecycle
 * using `setTimeout`-based timers (seconds, not minutes) and emits
 * protocol-shaped envelopes as it goes. One instance == one session.
 *
 * `MockAgentProvider.forNewSession(...)` is the normal entry point used by
 * `sessionStore` for brand-new sessions; `MockAgentProvider.forSeededSession(...)`
 * lets `sessionStore` seed a session that's already mid-lifecycle (or already
 * terminal) without replaying earlier stages.
 */
export class MockAgentProvider implements AgentProvider {
  readonly id = "mock";
  readonly displayName = "Mock Agent (simulated)";

  private readonly emitter = new EventEmitter();
  private session: AgentSession;
  private readonly scenario: MockScenario;
  private readonly scriptKey: (typeof SCRIPT_ROTATION)[number];
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private pendingApprovalId: string | null = null;
  /** Monotonically increasing per-session sequence for `terminal.output`, starting at 1. */
  private terminalSequence = 0;

  private constructor(session: AgentSession, scenario: MockScenario, scriptKey: string) {
    this.session = session;
    this.scenario = scenario;
    this.scriptKey = (EDIT_SCRIPTS[scriptKey] ? scriptKey : "auth") as (typeof SCRIPT_ROTATION)[number];
  }

  /**
   * Create a provider for a brand-new session and immediately begin its
   * lifecycle from `planning`. `sessionStore` is expected to have already
   * created and stored the initial `AgentSession` object and to emit
   * `session.created` itself; this method only drives what happens next.
   */
  static forNewSession(
    initialSession: AgentSession,
    scenario: MockScenario = "completes",
  ): MockAgentProvider {
    const scriptKey = nextScriptKey();
    const provider = new MockAgentProvider(initialSession, scenario, scriptKey);
    provider.runLifecycle();
    return provider;
  }

  /**
   * Wrap an already-fully-formed `AgentSession` (e.g. one seeded at server
   * startup that's already `testing`, `completed`, `failed`, etc.) without
   * replaying earlier lifecycle stages. If the seeded session is still
   * mid-flow (not a terminal status and not already `approvalNeeded`), the
   * provider continues the scripted lifecycle forward from that point.
   */
  static forSeededSession(
    seededSession: AgentSession,
    scenario: MockScenario,
    scriptKey: string,
    opts?: { resumeFrom?: AgentStatus },
  ): MockAgentProvider {
    const provider = new MockAgentProvider(seededSession, scenario, scriptKey);
    const resumeFrom = opts?.resumeFrom ?? seededSession.status;
    provider.continueFrom(resumeFrom);
    return provider;
  }

  // -- AgentProvider surface -----------------------------------------------

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    // MockAgentProvider instances are one-per-session and are constructed
    // via the static factories above; sessionStore calls those directly
    // rather than this method. This exists to satisfy the `AgentProvider`
    // interface uniformly across mock and future real providers.
    if (opts.sessionId !== this.session.id) {
      throw new Error(
        `MockAgentProvider instance is bound to session ${this.session.id}, not ${opts.sessionId}`,
      );
    }
    return this.session;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    this.assertSession(sessionId);
    const message: ChatMessage = {
      id: `msg_${randomUUID()}`,
      role: "user",
      text,
      timestamp: nowIso(),
    };
    this.session.messages.push(message);
    this.session.updatedAt = nowIso();
    this.emitSessionUpdated();

    if (this.stopped || this.isTerminal(this.session.status)) {
      return;
    }

    this.schedule(TICK_MS.chatReply, () => {
      this.appendAssistantMessage(this.believableReplyTo(text));
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    this.clearTimers();
    this.stopped = true;
    this.session.status = "failed";
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    this.session.updatedAt = nowIso();
    const reason: Localized = {
      en: "Stopped by user.",
      ja: "ユーザーによって停止されました。",
    };
    this.emit(
      envelope("session.failed", this.session.id, {
        reason,
        changedFileCount: this.session.changedFileCount,
      }),
    );
  }

  getStatus(sessionId: string): AgentSession | undefined {
    if (sessionId !== this.session.id) {
      return undefined;
    }
    return this.cloneSession();
  }

  streamEvents(onEvent: (envelope: OutboundEnvelope) => void): void {
    this.emitter.on("event", onEvent);
  }

  /** Resolve a pending approval for this session (called by sessionStore).
   * The mock doesn't model per-actionType auto-approval, so `allowSimilar`
   * is accepted for interface compatibility and ignored. */
  resolveApproval(approvalId: string, decision: ApprovalDecision, _allowSimilar?: boolean): boolean {
    if (this.pendingApprovalId !== approvalId || this.stopped) {
      return false;
    }
    this.pendingApprovalId = null;
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    this.session.updatedAt = nowIso();

    // This MVP only resolves approvals via an explicit `approval.decision`
    // from the client, so `resolvedBy` is always "user" for now. Timeout-
    // and system-initiated resolution are future work (see
    // `ApprovalResolvedBy` in ../types.ts).
    this.emit(
      envelope("approval.resolved", this.session.id, {
        approvalId,
        decision,
        resolvedBy: "user",
      }),
    );

    if (decision === "reject") {
      this.failSession({
        en: "The requested action was rejected, so the agent stopped here.",
        ja: "要求されたアクションが拒否されたため、エージェントはここで停止しました。",
      });
      return true;
    }

    // Approved: continue on to a second testing pass, then completion.
    this.runTestingPhase({ onPass: () => this.completeSession() });
    return true;
  }

  // -- Internal: lifecycle orchestration -----------------------------------

  private continueFrom(status: AgentStatus): void {
    switch (status) {
      case "planning":
      case "searching":
      case "editing":
      case "testing":
        // Seeded mid-flow; just resume forward from wherever it logically
        // continues to next (used for the "actively testing" seed session).
        if (status === "testing") {
          this.runTestingPhase({ onPass: () => this.completeSession() });
        } else {
          this.runLifecycle();
        }
        break;
      case "approvalNeeded":
        // Seeded already waiting on approval; nothing to schedule until
        // sessionStore calls resolveApproval().
        if (this.session.approvalRequest) {
          this.pendingApprovalId = this.session.approvalRequest.approvalId;
        }
        break;
      case "stuck":
      case "completed":
      case "failed":
      case "idle":
        // Terminal/steady seeded states: nothing to drive.
        break;
    }
  }

  private runLifecycle(): void {
    this.setStatus("planning", {
      en: "Starting up and reading the task description.",
      ja: "起動し、タスクの内容を読み込んでいます。",
    });

    this.schedule(TICK_MS.planning, () => this.runSearchingPhase());
  }

  private runSearchingPhase(): void {
    if (this.stopped) return;
    const script = EDIT_SCRIPTS[this.scriptKey]!;
    const firstStep = script[0]!;
    this.setStatus("searching", {
      en: `Searching the codebase to understand how ${firstStep.path} works today.`,
      ja: `${firstStep.path} の現在の実装を理解するため、コードベースを調査しています。`,
    });

    this.emitTerminalLine(`$ rg -n "${firstStep.path.split("/").pop()}" -l src`, "stdout");
    this.schedule(TICK_MS.outputLine, () =>
      this.emitTerminalLine(`Found relevant references in ${firstStep.path}`, "stdout"),
    );

    this.schedule(TICK_MS.searching, () => this.runEditingPhase());
  }

  private runEditingPhase(): void {
    if (this.stopped) return;
    const script = EDIT_SCRIPTS[this.scriptKey]!;
    this.setStatus("editing", script[0]!.activity);

    let cumulativeDelay = 0;
    for (const step of script) {
      cumulativeDelay += TICK_MS.outputLine;
      this.schedule(cumulativeDelay, () => {
        if (this.stopped) return;
        this.emitActivitySummary(step.activity);
        for (const line of step.terminalLines) {
          this.emitTerminalLine(line, "stdout");
        }
        this.applyFileChange(step);
      });
    }

    this.schedule(TICK_MS.editing, () =>
      this.runTestingPhase({
        onPass: () => this.afterFirstTestingPass(),
        // On the very first testing pass, the "failed" scenario's test run
        // itself is the thing that goes red — there is no approval step.
        failWith: this.scenario === "failed" ? this.failingTestReason() : undefined,
      }),
    );
  }

  /**
   * Run one pass of the test suite. If `failWith` is provided, this pass
   * ends in a failing `TestResult` and terminates the session; otherwise it
   * ends in a passing `TestResult` and calls `onPass`.
   */
  private runTestingPhase(opts: { onPass: () => void; failWith?: Localized }): void {
    if (this.stopped) return;
    this.setStatus("testing", {
      en: "Running the test suite to check the change.",
      ja: "変更を確認するためテストスイートを実行しています。",
    });
    this.session.testStatus = {
      status: "running",
      passedCount: 0,
      failedCount: 0,
      durationSeconds: 0,
      summary: { en: "Running test suite...", ja: "テストスイートを実行中です..." },
    };
    this.emit(
      envelope("tests.started", this.session.id, {
        testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      }),
    );
    this.emitTerminalLine("$ npm test", "stdout");
    this.schedule(TICK_MS.outputLine, () =>
      this.emitTerminalLine("> vitest run", "stdout"),
    );

    this.schedule(TICK_MS.testing, () => {
      if (this.stopped) return;

      if (opts.failWith) {
        this.runFailingTestResult(opts.failWith);
        return;
      }

      this.runPassingTestResult();
      opts.onPass();
    });
  }

  private failingTestReason(): Localized {
    return {
      en: "The test suite found a rounding bug that the current fix does not cover: negative totals still round incorrectly.",
      ja: "現在の修正ではカバーできない丸め処理のバグがテストで見つかりました: マイナス合計が依然として正しく丸められません。",
    };
  }

  private runPassingTestResult(): void {
    const passedCount = 12 + this.session.changedFiles.length * 2;
    const result: TestResult = {
      status: "passed",
      passedCount,
      failedCount: 0,
      durationSeconds: 8 + this.session.changedFiles.length,
      summary: {
        en: `All ${passedCount} tests passed.`,
        ja: `${passedCount}件すべてのテストに合格しました。`,
      },
    };
    this.session.testStatus = result;
    this.session.updatedAt = nowIso();
    this.emitTerminalLine(`✓ ${passedCount} passed (${result.durationSeconds}s)`, "stdout");
    this.emit(envelope("tests.finished", this.session.id, { testStatus: result }));
  }

  private runFailingTestResult(reason: Localized): void {
    const result: TestResult = {
      status: "failed",
      passedCount: 9,
      failedCount: 1,
      durationSeconds: 6,
      summary: {
        en: "1 of 10 tests failed: invoice rounding mismatch on negative totals.",
        ja: "10件中1件のテストが失敗しました: マイナス合計時の請求丸め処理が一致しません。",
      },
    };
    this.session.testStatus = result;
    this.session.updatedAt = nowIso();
    this.emitTerminalLine(
      "✗ invoice.test.ts > rounds negative totals correctly",
      "stderr",
    );
    this.emitTerminalLine(
      "  Expected: -12.50  Received: -12.49",
      "stderr",
    );
    this.emit(envelope("tests.finished", this.session.id, { testStatus: result }));
    this.failSession(reason);
  }

  private afterFirstTestingPass(): void {
    if (this.stopped) return;

    if (this.scenario === "stuck") {
      this.goStuck();
      return;
    }

    // "failed" scenario sessions never reach here: their first testing pass
    // already terminated the session via `failWith` in `runEditingPhase`.
    this.requestApproval();
  }

  private requestApproval(): void {
    if (this.stopped) return;
    const approval = APPROVAL_SCRIPTS[this.scriptKey]!;
    const approvalId = nextApprovalId();
    this.pendingApprovalId = approvalId;

    const request: ApprovalRequest = {
      approvalId,
      actionType: approval.actionType,
      command: approval.command,
      reason: approval.reason,
      riskLevel: approval.riskLevel,
      affectedFiles: approval.affectedFiles,
      recommendation: approval.recommendation,
    };

    this.session.status = "approvalNeeded";
    this.session.approvalRequired = true;
    this.session.approvalRequest = request;
    this.session.currentSummary = {
      en: `Waiting for approval to run "${approval.command}".`,
      ja: `"${approval.command}" の実行について承認を待っています。`,
    };
    this.session.updatedAt = nowIso();

    this.emit(
      envelope("agent.status.changed", this.session.id, {
        status: this.session.status,
        currentSummary: this.session.currentSummary,
      }),
    );
    this.emit(
      envelope("approval.required", this.session.id, {
        approvalId: request.approvalId,
        actionType: request.actionType,
        command: request.command,
        reason: request.reason,
        riskLevel: request.riskLevel,
        affectedFiles: request.affectedFiles,
        recommendation: request.recommendation,
      }),
    );
  }

  private goStuck(): void {
    this.session.status = "stuck";
    this.session.currentSummary = {
      en: "Not sure how to proceed — two valid approaches conflict. Could you clarify which one to take?",
      ja: "この先どう進めるべきか判断がつきません。有効な2つの方針が競合しています。どちらを採用すべきか教えてください。",
    };
    this.session.updatedAt = nowIso();

    this.emit(
      envelope("agent.status.changed", this.session.id, {
        status: this.session.status,
        currentSummary: this.session.currentSummary,
      }),
    );

    this.appendAssistantMessage(
      "I found two ways to fix this: (1) widen the refresh window in src/auth/session.ts, or " +
        "(2) change the client to retry once on a 401. Both work, but they have different " +
        "tradeoffs. Which approach would you like me to take?",
    );
  }

  private failSession(reason: Localized): void {
    this.clearTimers();
    this.session.status = "failed";
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("session.failed", this.session.id, {
        reason,
        changedFileCount: this.session.changedFileCount,
      }),
    );
  }

  private completeSession(): void {
    this.session.status = "completed";
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    const completionSummary: Localized = {
      en: `Done. ${this.session.changedFiles.length} file(s) changed and all tests pass.`,
      ja: `完了しました。${this.session.changedFiles.length}個のファイルを変更し、全テストに合格しています。`,
    };
    this.session.currentSummary = completionSummary;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("session.completed", this.session.id, {
        summary: completionSummary,
        changedFileCount: this.session.changedFileCount,
        testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      }),
    );
  }

  // -- Internal: small emit helpers ----------------------------------------

  private setStatus(status: AgentStatus, summary: Localized): void {
    this.session.status = status;
    this.session.currentSummary = summary;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("agent.status.changed", this.session.id, { status, currentSummary: summary }),
    );
  }

  private emitActivitySummary(summary: Localized): void {
    this.session.currentSummary = summary;
    this.session.updatedAt = nowIso();
    this.emit(envelope("activity.summary.updated", this.session.id, { currentSummary: summary }));
  }

  private emitTerminalLine(line: string, stream: "stdout" | "stderr"): void {
    this.session.logs.push(line);
    this.terminalSequence += 1;
    this.emit(
      envelope("terminal.output", this.session.id, {
        stream,
        text: line,
        sequence: this.terminalSequence,
      }),
    );
  }

  private appendAssistantMessage(text: string): void {
    const message: ChatMessage = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      text,
      timestamp: nowIso(),
    };
    this.session.messages.push(message);
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("chat.message", this.session.id, {
        messageId: message.id,
        role: "assistant",
        text,
      }),
    );
    this.emitSessionUpdated();
  }

  private applyFileChange(step: EditStep): void {
    const changedFile: ChangedFile = {
      path: step.path,
      changeType: step.changeType,
      summary: step.summary,
      diffPreview: step.diffPreview,
    };
    const existingIndex = this.session.changedFiles.findIndex((f) => f.path === step.path);
    if (existingIndex >= 0) {
      this.session.changedFiles[existingIndex] = changedFile;
    } else {
      this.session.changedFiles.push(changedFile);
    }
    this.session.changedFileCount = this.session.changedFiles.length;
    this.session.diffSummary = {
      en: `${this.session.changedFileCount} file${this.session.changedFileCount === 1 ? "" : "s"} changed.`,
      ja: `${this.session.changedFileCount}個のファイルが変更されました。`,
    };
    this.session.updatedAt = nowIso();

    this.emit(
      envelope("diff.updated", this.session.id, {
        changedFileCount: this.session.changedFileCount,
        changedFiles: this.cloneChangedFiles(),
        diffSummary: this.session.diffSummary,
      }),
    );
  }

  private believableReplyTo(userText: string): string {
    const lower = userText.toLowerCase();
    if (lower.includes("test")) {
      return "Sure — I'll make sure the test suite covers that before wrapping up.";
    }
    if (lower.includes("pr") || lower.includes("push")) {
      return "Got it, I'll open a PR once the tests are green.";
    }
    if (lower.includes("stop") || lower.includes("stuck")) {
      return "Understood, pausing here until you confirm how to proceed.";
    }
    return "Got it — continuing with that in mind.";
  }

  /**
   * Emit a `session.updated` patch containing only `updatedAt`. Used at call
   * sites (e.g. after a chat message is appended) where no other top-level
   * scalar field actually changed — chat messages themselves are not part of
   * this flat payload; the client already has them via other means.
   */
  private emitSessionUpdated(): void {
    this.emit(
      envelope("session.updated", this.session.id, {
        updatedAt: this.session.updatedAt,
      }),
    );
  }

  private emit(env: OutboundEnvelope): void {
    this.emitter.emit("event", env);
  }

  private schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      if (this.stopped) return;
      fn();
    }, delayMs);
    this.timers.push(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  private isTerminal(status: AgentStatus): boolean {
    return status === "completed" || status === "failed";
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.session.id) {
      throw new Error(
        `MockAgentProvider instance is bound to session ${this.session.id}, not ${sessionId}`,
      );
    }
  }

  private cloneSession(): AgentSession {
    return {
      ...this.session,
      currentSummary: { ...this.session.currentSummary },
      changedFiles: this.cloneChangedFiles(),
      testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      approvalRequest: this.session.approvalRequest
        ? {
            ...this.session.approvalRequest,
            reason: { ...this.session.approvalRequest.reason },
            affectedFiles: [...this.session.approvalRequest.affectedFiles],
          }
        : null,
      messages: this.session.messages.map((m) => ({ ...m })),
      logs: [...this.session.logs],
      diffSummary: { ...this.session.diffSummary },
    };
  }

  private cloneChangedFiles(): ChangedFile[] {
    return this.session.changedFiles.map((f) => ({ ...f, summary: { ...f.summary } }));
  }
}

export { emptyTestResult, EDIT_SCRIPTS, APPROVAL_SCRIPTS, SCRIPT_ROTATION };

// ---------------------------------------------------------------------------
// TerminalAgentProvider
// ---------------------------------------------------------------------------

/**
 * `TerminalAgentProvider` (Alpha) attaches Orbitory's host-agent to a real,
 * host-configured terminal process instead of simulating one with
 * `MockAgentProvider`. This is the foundation future real integrations
 * (Claude Code, Codex, Gemini CLI, Aider, OpenCode) will build on — this
 * Alpha itself only knows how to run whatever `TerminalAgentConfig` a host
 * operator configured in `orbitory.config.json` (see `../agentConfig.ts`);
 * it has no tool-specific knowledge of any particular coding agent CLI.
 *
 * Design, as implemented:
 *
 * 1. **Spawn the configured command.** `TerminalAgentProvider.forNewSession`
 *    calls `child_process.spawn(config.command, config.args, { cwd:
 *    config.workingDirectory, shell: false, ... })`. `shell: false` (the
 *    default, made explicit here) is load-bearing: `command`/`args` are
 *    passed straight to `execve`-family syscalls as an argv array, never
 *    handed to `/bin/sh` for interpretation, so shell metacharacters
 *    (`;`, `|`, `` ` ``, `$(...)`, etc.) anywhere in a configured arg are
 *    inert — there is no shell to interpret them. Process start is the
 *    `planning` status transition; the first line of output (or an
 *    explicit `[[STATUS]]` marker, see below) transitions to `editing`.
 *
 * 2. **Stream stdout/stderr as `terminal.output` — scrubbed first.** Output
 *    is buffered and split into lines; every line is passed through the
 *    centralized secret scrubber (`../scrubbing.ts`, one stateful
 *    `StreamScrubber` per stream so a PEM block on stderr can't affect
 *    stdout) *before* anything else happens to it — before marker parsing,
 *    before truncation, before it's stored in `session.logs`, and before it
 *    becomes a `terminal.output` envelope. Beyond scrubbing (and a
 *    `MAX_TERMINAL_LINE_CHARS` truncation for pathological single lines),
 *    output is preserved as-is per `docs/protocol.md` §9 — never localized
 *    or rewritten.
 *
 * 3. **A simple, opt-in marker convention for richer status.** Because
 *    Alpha has no tool-specific parser for any real agent CLI's output, a
 *    spawned process *may* (but doesn't have to) print specially-recognized
 *    marker lines that `parseTerminalLine` below understands, to drive real
 *    `agent.status.changed` / `activity.summary.updated` / `tests.started`
 *    / `tests.finished` envelopes instead of only raw `terminal.output`:
 *      `[[STATUS]] {"status":"testing","summary":{"en":"...","ja":"..."}}`
 *      `[[SUMMARY]] {"en":"...","ja":"..."}`
 *      `[[TESTS_STARTED]] {"summary":{"en":"...","ja":"..."}}`
 *      `[[TESTS_FINISHED]] {"status":"passed","passedCount":N,"failedCount":N,"durationSeconds":N,"summary":{"en":"...","ja":"..."}}`
 *    A marker line is consumed (not also forwarded as `terminal.output`);
 *    any line that isn't a recognized marker — including one that merely
 *    starts with `[[` — is forwarded as plain output, so nothing is ever
 *    silently swallowed. `scripts/demo-agent.js` is the reference producer
 *    of this convention. A future real-CLI adapter would likely replace
 *    this with tool-specific parsing instead of relying on the target CLI
 *    to know about Orbitory's markers.
 *
 * 4. **Map process exit to `session.completed` / `session.failed`.** Exit
 *    code `0` → `session.completed`. Non-zero exit, a signal, or a spawn
 *    error (e.g. command not found) → `session.failed` with a reason
 *    mentioning the exit code/signal/error.
 *
 * 5. **`session.stop` terminates the process safely.** Sends `SIGTERM`,
 *    then escalates to `SIGKILL` after `STOP_GRACE_MS` if the process
 *    hasn't exited by then. The resulting `session.failed` reason is
 *    "Stopped by user." — the same convention `MockAgentProvider` uses.
 *
 * 6. **`chat.message` is never a shell command.** `sendMessage` only ever
 *    writes the message text (plus a trailing newline) to the *already
 *    running, already allowlisted* child process's own stdin — it is never
 *    passed to a shell, never used to spawn a new process, and never
 *    otherwise interpreted as a command. If the process has already exited,
 *    the message is still recorded in `session.messages` (so it's visible
 *    in chat history) but is simply not delivered anywhere.
 *
 * 7. **No secrets forwarded to the child.** The spawned process inherits
 *    the host-agent's environment (so `PATH` etc. resolve normally) *except*
 *    `ORBITORY_PAIRING_TOKEN`, which is explicitly stripped — the child
 *    doesn't need it and shouldn't have it (least privilege).
 *
 * 8. **Runtime safety limits.** Every session has a wall-clock ceiling
 *    (`config.maxRuntimeSeconds`, default 1 hour — see `../agentConfig.ts`);
 *    exceeding it terminates the process (SIGTERM → SIGKILL) and fails the
 *    session with an explicit "exceeded maximum runtime" reason. Individual
 *    output lines are capped at `MAX_TERMINAL_LINE_CHARS` (scrubbed first,
 *    truncated second — so a secret can never survive by hiding past the
 *    truncation point of a line that was cut before scrubbing), and
 *    `session.logs` is a ring buffer capped at `MAX_SESSION_LOG_LINES` so a
 *    chatty process can't grow host-agent memory (and `session.snapshot`
 *    payloads) without bound.
 *
 * See `docs/security.md` §4 for the full threat model, the scrubber's honest
 * limitations (pattern-based, best effort — NOT a guarantee), and what is
 * still not safe about this Alpha (no process sandboxing: the child runs
 * with the host-agent's own privileges).
 */

/** Grace period between SIGTERM and SIGKILL when stopping a session.
 * Exported (Phase 16) for reuse by `ClaudeCodeStreamProvider` — one value,
 * not two copies that can drift. */
export const STOP_GRACE_MS = 2_000;

/**
 * Longest single `terminal.output` line forwarded to clients (and stored in
 * `session.logs`). Applied AFTER scrubbing, so truncation can never expose
 * a secret that scrubbing would have caught. Anything longer is cut and
 * marked with `TRUNCATION_SUFFIX`.
 */
export const MAX_TERMINAL_LINE_CHARS = 4_096;

/** Marker appended to a line that was cut at `MAX_TERMINAL_LINE_CHARS`. */
export const TRUNCATION_SUFFIX = " [TRUNCATED]";

/**
 * Ring-buffer cap for `session.logs`. Oldest lines are dropped first once
 * exceeded — `session.snapshot` / `GET /sessions` therefore carry at most
 * this many trailing lines per session.
 */
export const MAX_SESSION_LOG_LINES = 2_000;

/**
 * Cumulative cap on bytes forwarded/stored per session (Phase 4.5), on top of
 * the per-line (`MAX_TERMINAL_LINE_CHARS`) and per-session-line-count
 * (`MAX_SESSION_LOG_LINES` ring buffer) limits. A process that produces an
 * enormous *number* of moderately-sized lines could still push a lot of total
 * bytes to a connected client over a session's lifetime; once this ceiling is
 * crossed, further output is suppressed (with one host notice) while the
 * process is otherwise left to run to its natural exit / runtime ceiling.
 */
export const MAX_SESSION_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Every process this provider has ever spawned, for the shutdown safety net below. */
const activeChildren = new Set<ChildProcess>();

/**
 * Register/unregister a spawned child with the module's shutdown safety net
 * (the `process.on("exit")` handler below). Exported (Phase 16) so
 * `ClaudeCodeStreamProvider` children get the same orphan protection as
 * `TerminalAgentProvider` children — same sets, one safety net.
 */
export function registerActiveChild(child: ChildProcess, opts?: { detachedGroupPid?: number }): void {
  activeChildren.add(child);
  if (opts?.detachedGroupPid !== undefined) {
    detachedGroupPids.add(opts.detachedGroupPid);
  }
}

export function unregisterActiveChild(child: ChildProcess, detachedGroupPid?: number): void {
  activeChildren.delete(child);
  activeContainers.delete(child);
  if (detachedGroupPid !== undefined) {
    detachedGroupPids.delete(detachedGroupPid);
  }
}

/**
 * Build the environment a terminal-backed child is spawned with, per the
 * config's `envAllowlist` policy (see `TerminalAgentConfig.envAllowlist`):
 * no allowlist → full inherit; an allowlist (even empty) → ONLY those keys.
 * `ORBITORY_PAIRING_TOKEN` is stripped unconditionally in both cases, and env
 * values are never logged. Extracted from `TerminalAgentProvider` (Phase 16)
 * so `ClaudeCodeStreamProvider` shares the exact policy instead of copying it;
 * behavior is byte-for-byte the Phase 4 semantics.
 */
export function buildTerminalChildEnv(envAllowlist: string[] | undefined): NodeJS.ProcessEnv {
  const { ORBITORY_PAIRING_TOKEN: _omit, ...fullEnv } = process.env;

  // Absent `envAllowlist` → inherit the full environment. A *present*
  // allowlist means "I'm controlling the environment": pass only those keys
  // — including when it's an empty array (pass nothing), which is
  // fail-closed and less surprising than treating `[]` as "inherit all".
  if (envAllowlist === undefined) {
    return fullEnv;
  }

  const restricted: NodeJS.ProcessEnv = {};
  for (const key of envAllowlist) {
    if (key === "ORBITORY_PAIRING_TOKEN") continue;
    const value = fullEnv[key];
    if (value !== undefined) {
      restricted[key] = value;
    }
  }
  return restricted;
}

/**
 * PIDs of children spawned *detached* (their own process group — the sandbox
 * modes, see `wrapCommandForSandbox`). At shutdown these are signalled by
 * negative PID so the whole group dies, not just the group leader. Tracked
 * separately from `activeChildren` because negative-PID signalling is only safe
 * for processes we deliberately made group leaders — doing it to a
 * non-detached child would target the host-agent's OWN process group.
 */
const detachedGroupPids = new Set<number>();

/**
 * Container-backed sessions whose engine-client process is still alive, so the
 * shutdown safety net below can `<engine> rm -f <name>` them: killing the
 * engine *client* does not necessarily kill the *container* (the daemon owns
 * it), so a Ctrl-C'd host-agent could otherwise leave containers running.
 * Best-effort and bounded (`spawnSync` with a short timeout per container).
 */
const activeContainers = new Map<ChildProcess, { engineExecutable: string; name: string }>();

/**
 * Best-effort cleanup: if the host-agent process itself exits (e.g. Ctrl-C)
 * while a terminal-backed session's child process is still running, make
 * sure it doesn't become an orphan. `process.on("exit", ...)` handlers must
 * be synchronous; sending a signal is fire-and-forget, which is all that's
 * possible at this point in the Node.js shutdown sequence anyway.
 */
process.on("exit", () => {
  for (const pid of detachedGroupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group already gone; nothing to do.
    }
  }
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone; nothing to do.
    }
  }
  // Containers are owned by the engine daemon, not by the client process we
  // just killed, so ask the engine to remove them too. `process.on("exit")`
  // handlers must be synchronous — spawnSync with a short timeout keeps this
  // bounded (worst case ~1.5s per still-running container).
  for (const [, container] of activeContainers) {
    try {
      spawnSync(container.engineExecutable, ["rm", "-f", container.name], {
        stdio: "ignore",
        timeout: 1_500,
      });
    } catch {
      // Best-effort only.
    }
  }
});

const KNOWN_STATUSES: readonly AgentStatus[] = [
  "planning",
  "searching",
  "editing",
  "testing",
  "stuck",
  "approvalNeeded",
  "completed",
  "failed",
  "idle",
];

function isKnownStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && (KNOWN_STATUSES as readonly string[]).includes(value);
}

function isLocalized(value: unknown): value is Localized {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { en?: unknown }).en === "string" &&
    typeof (value as { ja?: unknown }).ja === "string"
  );
}

/** Result of parsing a single line of a terminal agent's output. */
export type ParsedTerminalLine =
  | { kind: "status"; status: AgentStatus; summary: Localized }
  | { kind: "summary"; summary: Localized }
  | { kind: "testsStarted"; summary: Localized }
  | { kind: "testsFinished"; result: TestResult }
  | { kind: "plain" };

/**
 * Parses one line of stdout/stderr from a `TerminalAgentProvider`-spawned
 * process against the `[[STATUS]]` / `[[SUMMARY]]` / `[[TESTS_STARTED]]` /
 * `[[TESTS_FINISHED]]` marker convention documented on the class above.
 * Exported (and pure/side-effect-free) so it can be unit-tested directly
 * without spawning a real process. Any line that isn't a recognized,
 * well-formed marker — including malformed JSON after a marker, or an
 * unrecognized `[[...]]`-looking prefix — parses as `{ kind: "plain" }`, so
 * the caller forwards it as ordinary `terminal.output` rather than losing it.
 */
export function parseTerminalLine(line: string): ParsedTerminalLine {
  const statusMatch = /^\[\[STATUS\]\]\s*(.+)$/.exec(line);
  if (statusMatch?.[1]) {
    try {
      const parsed = JSON.parse(statusMatch[1]) as { status?: unknown; summary?: unknown };
      if (isKnownStatus(parsed.status) && isLocalized(parsed.summary)) {
        return { kind: "status", status: parsed.status, summary: parsed.summary };
      }
    } catch {
      // Malformed JSON after the marker; fall through to "plain".
    }
    return { kind: "plain" };
  }

  const summaryMatch = /^\[\[SUMMARY\]\]\s*(.+)$/.exec(line);
  if (summaryMatch?.[1]) {
    try {
      const parsed = JSON.parse(summaryMatch[1]);
      if (isLocalized(parsed)) {
        return { kind: "summary", summary: parsed };
      }
    } catch {
      // Fall through to "plain".
    }
    return { kind: "plain" };
  }

  const testsStartedMatch = /^\[\[TESTS_STARTED\]\]\s*(.+)$/.exec(line);
  if (testsStartedMatch?.[1]) {
    try {
      const parsed = JSON.parse(testsStartedMatch[1]) as { summary?: unknown };
      const summary = isLocalized(parsed.summary)
        ? parsed.summary
        : { en: "Running test suite...", ja: "テストスイートを実行中です..." };
      return { kind: "testsStarted", summary };
    } catch {
      return { kind: "plain" };
    }
  }

  const testsFinishedMatch = /^\[\[TESTS_FINISHED\]\]\s*(.+)$/.exec(line);
  if (testsFinishedMatch?.[1]) {
    try {
      const parsed = JSON.parse(testsFinishedMatch[1]) as {
        status?: unknown;
        passedCount?: unknown;
        failedCount?: unknown;
        durationSeconds?: unknown;
        summary?: unknown;
      };
      if (
        (parsed.status === "passed" || parsed.status === "failed") &&
        typeof parsed.passedCount === "number" &&
        typeof parsed.failedCount === "number" &&
        typeof parsed.durationSeconds === "number" &&
        isLocalized(parsed.summary)
      ) {
        return {
          kind: "testsFinished",
          result: {
            status: parsed.status,
            passedCount: parsed.passedCount,
            failedCount: parsed.failedCount,
            durationSeconds: parsed.durationSeconds,
            summary: parsed.summary,
          },
        };
      }
    } catch {
      // Fall through to "plain".
    }
    return { kind: "plain" };
  }

  return { kind: "plain" };
}

/** Splits a stream chunk into complete lines, holding back a trailing partial line in `buffer`. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; remainder: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
}

export class TerminalAgentProvider implements AgentProvider {
  readonly id = "terminal";
  readonly displayName: string;

  private readonly emitter = new EventEmitter();
  private session: AgentSession;
  private readonly config: TerminalAgentConfig;
  private child: ChildProcess | null = null;
  private stopped = false;
  private timedOut = false;
  private sawFirstOutput = false;
  private terminalSequence = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stopTimer: NodeJS.Timeout | null = null;
  private runtimeTimer: NodeJS.Timeout | null = null;
  /** Whether the child was spawned detached (own process group — sandbox modes). */
  private detached = false;
  /**
   * `--name` used when this session runs in a container (Phase 5.5), so
   * stop/cleanup paths can target the container itself, not just the engine
   * client process. Derived from the session id, which is unique per process.
   */
  private readonly containerName: string;
  /** Set once the child's `exit` (or terminal `error`) has fired, so termination escalation is a no-op afterward. */
  private childExited = false;
  /** Cumulative UTF-8 bytes forwarded this session, for the `MAX_SESSION_OUTPUT_BYTES` cap. */
  private emittedBytes = 0;
  /** Once true, further terminal output is suppressed (the per-session byte cap was hit). */
  private outputLimitReached = false;
  /**
   * One stateful scrubber per stream: a PEM private-key block printed to one
   * stream must not toggle redaction state on the other. The host-agent's
   * own pairing token is always redacted as an extra literal, belt-and-
   * suspenders on top of it being stripped from the child's environment.
   */
  private readonly scrubbers = {
    stdout: new StreamScrubber([PAIRING_TOKEN]),
    stderr: new StreamScrubber([PAIRING_TOKEN]),
  } as const;
  /**
   * Bilingual lifecycle copy for this session's `agentType` (e.g. a
   * `claudeCode` session reads "Claude Code is working…"). Presentation only
   * — see `agentPresets.ts`; the execution path is identical for every type.
   */
  private readonly copy: AgentPresetCopy;

  private constructor(session: AgentSession, config: TerminalAgentConfig) {
    this.session = session;
    this.config = config;
    this.displayName = `Terminal Agent (${config.displayName})`;
    // The session's agentType is host-authoritative (set from config by
    // sessionStore for terminal-backed sessions), so keying copy off it is
    // equivalent to keying off config.agentType.
    this.copy = presetCopy(session.agentType, config.displayName);
    this.containerName = `orbitory-${session.id}`;
  }

  /**
   * Create a provider for a brand-new session and immediately spawn the
   * configured process. `sessionStore` is expected to have already created
   * and stored the initial `AgentSession` and to emit `session.created`
   * itself; this method only drives what happens next, exactly like
   * `MockAgentProvider.forNewSession`.
   */
  static forNewSession(initialSession: AgentSession, config: TerminalAgentConfig): TerminalAgentProvider {
    const provider = new TerminalAgentProvider(initialSession, config);
    provider.spawnProcess();
    return provider;
  }

  // -- AgentProvider surface -----------------------------------------------

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    // Mirrors MockAgentProvider.startSession: instances are one-per-session
    // and constructed via forNewSession above; this exists only to satisfy
    // the AgentProvider interface uniformly.
    if (opts.sessionId !== this.session.id) {
      throw new Error(
        `TerminalAgentProvider instance is bound to session ${this.session.id}, not ${opts.sessionId}`,
      );
    }
    return this.session;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    this.assertSession(sessionId);

    const message: ChatMessage = {
      id: `msg_${randomUUID()}`,
      role: "user",
      text,
      timestamp: nowIso(),
    };
    this.session.messages.push(message);
    this.session.updatedAt = nowIso();
    this.emitSessionUpdated();

    // Deliver the raw text to the already-running child's stdin — never to
    // a shell, never re-parsed as a command. If the process has already
    // exited (or its stdin is otherwise unusable), the message stays in
    // chat history but simply isn't delivered anywhere.
    if (this.child && !this.child.killed && this.child.stdin && this.child.stdin.writable) {
      try {
        this.child.stdin.write(`${text}\n`);
      } catch {
        // Best-effort; a write failure here (e.g. EPIPE) isn't fatal to the
        // session, it just means this particular message wasn't delivered.
      }
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    if (this.stopped || this.isTerminal(this.session.status)) {
      return;
    }
    this.stopped = true;

    if (this.child && !this.childExited) {
      this.terminateWithEscalation();
    } else {
      // No live process (e.g. spawn already failed); finalize immediately.
      this.finalizeAsStoppedByUser();
    }
  }

  getStatus(sessionId: string): AgentSession | undefined {
    if (sessionId !== this.session.id) {
      return undefined;
    }
    return this.cloneSession();
  }

  streamEvents(onEvent: (envelope: OutboundEnvelope) => void): void {
    this.emitter.on("event", onEvent);
  }

  /** TerminalAgentProvider Alpha never raises approvals; always a no-op. */
  resolveApproval(_approvalId: string, _decision: ApprovalDecision, _allowSimilar?: boolean): boolean {
    return false;
  }

  // -- Internal: process lifecycle -----------------------------------------

  private spawnProcess(): void {
    this.setStatus("planning", this.copy.starting);

    // Surface the effective sandbox to anyone watching Live — including bluntly
    // when it's `none`. Host-authored constant text (no process data, no
    // secrets). Deferred to a microtask because `forNewSession` runs this
    // synchronously *before* sessionStore has subscribed to our emitter (see
    // sessionStore.startSession → wireProvider); a synchronous emit here would
    // be dropped. The microtask fires after that subscription but before any
    // child I/O, so the banner still arrives as the first terminal line. It
    // does NOT trip the "first output → editing" transition (that only happens
    // for real process lines in processLine).
    queueMicrotask(() => {
      if (this.isTerminal(this.session.status)) return;
      this.emitTerminalLine(describeSandbox(this.config.sandbox), "stdout");
    });

    // Container invariant guard: a resolved container sandbox always carries
    // its settings + engine executable (see sandbox.ts resolution). If that is
    // ever violated, fail closed rather than run less confined than declared.
    const isContainer = this.config.sandbox.effectiveMode === "container";
    if (isContainer && !this.config.sandbox.container) {
      this.failSessionAfterSubscription({
        en: `${this.config.displayName} declares a container sandbox without container settings; refusing to start.`,
        ja: `${this.config.displayName} はコンテナ設定のないコンテナサンドボックスを宣言しているため、起動を拒否しました。`,
      });
      return;
    }

    // Container mode: the spawned process is the ENGINE CLIENT (docker/podman),
    // which is host tooling and needs its own env (minus the pairing token) to
    // reach the daemon; the AGENT's env inside the container is governed solely
    // by `-e KEY` flags built from envAllowlist. Non-container modes keep the
    // Phase 4 buildChildEnv behavior byte-for-byte.
    const childEnv = isContainer ? this.buildEngineClientEnv() : this.buildChildEnv();
    const wrapped = wrapCommandForSandbox(
      this.config.command,
      this.config.args,
      this.config.sandbox,
      this.config.workingDirectory,
      isContainer
        ? {
            envPassthroughKeys: this.containerEnvPassthroughKeys(),
            containerName: this.containerName,
          }
        : undefined,
    );
    this.detached = wrapped.detached;

    let child: ChildProcess;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd: this.config.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: childEnv,
        // Sandbox modes run in their own process group so stop/timeout can reap
        // the whole tree (a real CLI may spawn children). `none` stays attached,
        // byte-identical to pre-4.5 behavior.
        detached: wrapped.detached,
      });
    } catch (err) {
      // Error messages can quote paths/arguments from the failed spawn;
      // scrub them like any other process-derived text before they leave
      // the host as a session.failed reason.
      const message = scrubSecrets((err as Error).message, [PAIRING_TOKEN]);
      this.failSessionAfterSubscription({
        en: `Failed to start ${this.config.displayName}: ${message}`,
        ja: `${this.config.displayName} の起動に失敗しました: ${message}`,
      });
      return;
    }

    this.child = child;
    activeChildren.add(child);
    if (this.detached && child.pid !== undefined) {
      detachedGroupPids.add(child.pid);
    }
    if (isContainer && this.config.sandbox.container) {
      activeContainers.set(child, {
        engineExecutable: this.config.sandbox.container.engineExecutable,
        name: this.containerName,
      });
    }

    // Wall-clock ceiling: a process that outlives config.maxRuntimeSeconds
    // is terminated the same way session.stop terminates it (SIGTERM, then
    // SIGKILL after the grace period), but the session fails with an
    // explicit runtime-exceeded reason instead of "Stopped by user."
    this.runtimeTimer = setTimeout(() => {
      if (this.stopped || this.isTerminal(this.session.status)) return;
      this.timedOut = true;
      this.terminateWithEscalation();
    }, this.config.maxRuntimeSeconds * 1000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: string) => this.handleOutput(chunk, "stderr"));

    child.on("error", (err) => {
      this.childExited = true;
      activeChildren.delete(child);
      activeContainers.delete(child);
      if (child.pid !== undefined) detachedGroupPids.delete(child.pid);
      this.clearRuntimeTimer();
      if (this.isTerminal(this.session.status)) return;
      const message = scrubSecrets(err.message, [PAIRING_TOKEN]);
      this.failSession({
        en: `${this.config.displayName} could not be started or crashed: ${message}`,
        ja: `${this.config.displayName} を起動できないか、異常終了しました: ${message}`,
      });
    });

    child.on("exit", (code, signal) => {
      this.childExited = true;
      activeChildren.delete(child);
      activeContainers.delete(child);
      if (child.pid !== undefined) detachedGroupPids.delete(child.pid);
      this.clearRuntimeTimer();
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.flushRemainingBuffers();

      if (this.stopped) {
        this.finalizeAsStoppedByUser();
        return;
      }

      if (this.timedOut) {
        this.failSession({
          en: `${this.config.displayName} exceeded its maximum runtime (${this.config.maxRuntimeSeconds}s) and was terminated.`,
          ja: `${this.config.displayName} は最大実行時間（${this.config.maxRuntimeSeconds}秒）を超えたため終了されました。`,
        });
        return;
      }

      if (code === 0) {
        this.completeSession();
        return;
      }

      const reason: Localized =
        signal !== null
          ? {
              en: `${this.config.displayName} was terminated by signal ${signal}.`,
              ja: `${this.config.displayName} はシグナル ${signal} により終了しました。`,
            }
          : {
              en: `${this.config.displayName} exited with code ${code}.`,
              ja: `${this.config.displayName} はコード ${code} で終了しました。`,
            };
      this.failSession(reason);
    });
  }

  /**
   * Send `signal` to the child — to its whole process *group* when it was
   * spawned detached (a sandbox mode), so any subprocesses a real CLI spawned
   * die too, not just the group leader. Falls back to a direct child signal if
   * the group is already gone. A no-op once the child has exited.
   *
   * Negative-PID signalling is only ever done for `this.detached` children:
   * doing it to an attached child would target the host-agent's OWN process
   * group (see `detachedGroupPids`).
   */
  private terminateChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || this.childExited || child.pid === undefined) {
      return;
    }
    if (this.detached) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Group already gone or not permitted — fall through to direct kill.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone; nothing to do.
    }
  }

  /**
   * Terminate the child with SIGTERM, then escalate to SIGKILL after
   * `STOP_GRACE_MS` if it hasn't exited (the escalation is guarded by
   * `childExited`, so a process that obeys SIGTERM is never SIGKILLed after the
   * fact, and one that ignores it always is — the previous `.killed`-based
   * guard could skip the SIGKILL entirely).
   *
   * For a container session, SIGTERM reaches the container's process via the
   * engine client's signal proxying; SIGKILL, however, kills only the *client*,
   * which can leave the container itself running under the daemon — so the
   * escalation path also asks the engine to remove the container by name,
   * best-effort.
   */
  private terminateWithEscalation(): void {
    this.terminateChild("SIGTERM");
    this.stopTimer = setTimeout(() => {
      if (this.childExited) return;
      this.terminateChild("SIGKILL");
      this.removeContainerBestEffort();
    }, STOP_GRACE_MS);
  }

  /**
   * Fire-and-forget `<engine> rm -f <name>` for this session's container, used
   * after a SIGKILL escalation (see above). Never throws, never blocks, never
   * emits anything to the client; a no-op for non-container sessions.
   */
  private removeContainerBestEffort(): void {
    const container = this.config.sandbox.container;
    if (!container) return;
    try {
      const cleanup = spawn(container.engineExecutable, ["rm", "-f", this.containerName], {
        stdio: "ignore",
        detached: true,
      });
      cleanup.on("error", () => {
        // Engine missing/daemon down — nothing more we can do.
      });
      cleanup.unref();
    } catch {
      // Best-effort only.
    }
  }

  private handleOutput(chunk: string, stream: "stdout" | "stderr"): void {
    const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    const { lines, remainder } = splitLines(this[bufferKey], chunk);
    this[bufferKey] = remainder;
    for (const line of lines) {
      this.processLine(line, stream);
    }
  }

  private flushRemainingBuffers(): void {
    if (this.stdoutBuffer.length > 0) {
      this.processLine(this.stdoutBuffer, "stdout");
      this.stdoutBuffer = "";
    }
    if (this.stderrBuffer.length > 0) {
      this.processLine(this.stderrBuffer, "stderr");
      this.stderrBuffer = "";
    }
  }

  private processLine(rawLine: string, stream: "stdout" | "stderr"): void {
    // Scrub FIRST — before marker parsing, truncation, storage, or emission —
    // so no downstream path (terminal.output, session.logs, marker-derived
    // status/summary/test events) can ever see the unscrubbed text. Truncate
    // AFTER scrubbing: cutting first could bisect a secret so its pattern no
    // longer matches, leaking the surviving half.
    const scrubbed = this.scrubbers[stream].scrubLine(rawLine);
    const line =
      scrubbed.length > MAX_TERMINAL_LINE_CHARS
        ? scrubbed.slice(0, MAX_TERMINAL_LINE_CHARS) + TRUNCATION_SUFFIX
        : scrubbed;

    const parsed = parseTerminalLine(line);

    if (parsed.kind === "plain") {
      if (!this.sawFirstOutput && !this.isTerminal(this.session.status)) {
        this.sawFirstOutput = true;
        this.setStatus("editing", this.copy.running);
      }
      this.emitTerminalLine(line, stream);
      return;
    }

    this.sawFirstOutput = true;

    switch (parsed.kind) {
      case "status":
        this.setStatus(parsed.status, parsed.summary);
        return;
      case "summary":
        this.emitActivitySummary(parsed.summary);
        return;
      case "testsStarted": {
        const running: TestResult = {
          status: "running",
          passedCount: 0,
          failedCount: 0,
          durationSeconds: 0,
          summary: parsed.summary,
        };
        this.session.testStatus = running;
        this.session.updatedAt = nowIso();
        this.emit(envelope("tests.started", this.session.id, { testStatus: running }));
        return;
      }
      case "testsFinished":
        this.session.testStatus = parsed.result;
        this.session.updatedAt = nowIso();
        this.emit(envelope("tests.finished", this.session.id, { testStatus: parsed.result }));
        return;
    }
  }

  private finalizeAsStoppedByUser(): void {
    if (this.isTerminal(this.session.status)) return;
    this.failSession({ en: "Stopped by user.", ja: "ユーザーによって停止されました。" });
  }

  private failSession(reason: Localized): void {
    this.session.status = "failed";
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("session.failed", this.session.id, {
        reason,
        changedFileCount: this.session.changedFileCount,
      }),
    );
  }

  /**
   * Fail the session on a microtask instead of synchronously. Used for the
   * synchronous early-exit paths in `spawnProcess` (the container-invariant
   * guard and the `spawn()`-threw catch): `forNewSession` runs `spawnProcess`
   * *before* `sessionStore` subscribes to our emitter via `wireProvider`, so a
   * synchronous `failSession` here would emit `session.failed` into the void
   * and the live client that issued `session.start` would be left seeing only
   * the `planning` `session.created` — a stuck session. The microtask fires
   * after subscription (same fix the sandbox banner uses). Guarded so it never
   * double-fails a session that already reached a terminal state.
   */
  private failSessionAfterSubscription(reason: Localized): void {
    queueMicrotask(() => {
      if (this.isTerminal(this.session.status)) return;
      this.failSession(reason);
    });
  }

  private completeSession(): void {
    this.session.status = "completed";
    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    const completionSummary: Localized = this.copy.completed;
    this.session.currentSummary = completionSummary;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("session.completed", this.session.id, {
        summary: completionSummary,
        changedFileCount: this.session.changedFileCount,
        testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      }),
    );
  }

  // -- Internal: small emit helpers ----------------------------------------

  private setStatus(status: AgentStatus, summary: Localized): void {
    this.session.status = status;
    this.session.currentSummary = summary;
    this.session.updatedAt = nowIso();
    this.emit(envelope("agent.status.changed", this.session.id, { status, currentSummary: summary }));
  }

  private emitActivitySummary(summary: Localized): void {
    this.session.currentSummary = summary;
    this.session.updatedAt = nowIso();
    this.emit(envelope("activity.summary.updated", this.session.id, { currentSummary: summary }));
  }

  private emitTerminalLine(line: string, stream: "stdout" | "stderr"): void {
    // Per-session byte ceiling: once crossed, suppress all further output.
    if (this.outputLimitReached) {
      return;
    }

    this.pushTerminalLine(line, stream);

    this.emittedBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
    if (this.emittedBytes > MAX_SESSION_OUTPUT_BYTES) {
      this.outputLimitReached = true;
      // One final host notice, emitted directly (bypassing the guard we just
      // set) so the client learns output was cut rather than silently stopping.
      this.pushTerminalLine(
        "[orbitory] per-session output limit reached; further output is suppressed (the process keeps running).",
        "stdout",
      );
    }
  }

  /** Push one line to the log ring buffer and emit it as `terminal.output`. */
  private pushTerminalLine(line: string, stream: "stdout" | "stderr"): void {
    this.session.logs.push(line);
    // Ring buffer: drop the oldest lines once the cap is exceeded, so a
    // chatty process can't grow host-agent memory (or session.snapshot
    // payload size) without bound.
    if (this.session.logs.length > MAX_SESSION_LOG_LINES) {
      this.session.logs.splice(0, this.session.logs.length - MAX_SESSION_LOG_LINES);
    }
    this.terminalSequence += 1;
    this.emit(
      envelope("terminal.output", this.session.id, {
        stream,
        text: line,
        sequence: this.terminalSequence,
      }),
    );
  }

  private emitSessionUpdated(): void {
    this.emit(envelope("session.updated", this.session.id, { updatedAt: this.session.updatedAt }));
  }

  private emit(env: OutboundEnvelope): void {
    this.emitter.emit("event", env);
  }

  /**
   * Builds the environment the child process is spawned with, per the
   * config's `envAllowlist` policy (see `TerminalAgentConfig.envAllowlist`):
   *
   * - No `envAllowlist` → inherit the full environment (the less-safe
   *   default), minus the pairing token.
   * - `envAllowlist` present → include ONLY those keys from the host-agent's
   *   environment (each only if actually set), a least-privilege posture for
   *   a real CLI.
   *
   * `ORBITORY_PAIRING_TOKEN` is stripped in BOTH cases — the child never needs
   * the host-agent's own pairing secret, and an operator listing it in
   * `envAllowlist` (by mistake) must not smuggle it through. Env values are
   * never logged here or anywhere. (Phase 16: the policy itself lives in the
   * exported `buildTerminalChildEnv` above, shared with
   * `ClaudeCodeStreamProvider`; semantics unchanged.)
   */
  private buildChildEnv(): NodeJS.ProcessEnv {
    return buildTerminalChildEnv(this.config.envAllowlist);
  }

  /**
   * Environment for the container ENGINE CLIENT (docker/podman) itself: the
   * full host env minus the pairing token. The client is trusted host tooling
   * that needs its own configuration (PATH, HOME, DOCKER_HOST, …) to reach the
   * daemon. The AGENT's environment inside the container is governed solely by
   * the key-only `-e KEY` flags built from `envAllowlist` (see
   * `containerEnvPassthroughKeys` / `buildContainerArgv`) — and the engine
   * reads those values from THIS env, which is why allowlisted values must be
   * present here while never appearing in argv.
   */
  private buildEngineClientEnv(): NodeJS.ProcessEnv {
    const { ORBITORY_PAIRING_TOKEN: _omit, ...fullEnv } = process.env;
    return fullEnv;
  }

  /**
   * Env keys to forward into the container via `-e KEY`. Container least-
   * privilege default: an *omitted* `envAllowlist` forwards NOTHING (the
   * container starts from the image's own environment) — deliberately unlike
   * the non-container full-inherit default; see the `envAllowlist` field doc
   * in `agentConfig.ts`. The pairing token and non-env-name keys are dropped
   * here (and again in the builder) even if misconfigured in.
   */
  private containerEnvPassthroughKeys(): string[] {
    return (this.config.envAllowlist ?? []).filter(
      (key) =>
        key !== "ORBITORY_PAIRING_TOKEN" &&
        ENV_NAME_PATTERN.test(key) &&
        process.env[key] !== undefined,
    );
  }

  private clearRuntimeTimer(): void {
    if (this.runtimeTimer) {
      clearTimeout(this.runtimeTimer);
      this.runtimeTimer = null;
    }
  }

  private isTerminal(status: AgentStatus): boolean {
    return status === "completed" || status === "failed";
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.session.id) {
      throw new Error(
        `TerminalAgentProvider instance is bound to session ${this.session.id}, not ${sessionId}`,
      );
    }
  }

  private cloneSession(): AgentSession {
    return {
      ...this.session,
      currentSummary: { ...this.session.currentSummary },
      changedFiles: this.session.changedFiles.map((f) => ({ ...f, summary: { ...f.summary } })),
      testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      approvalRequest: this.session.approvalRequest
        ? {
            ...this.session.approvalRequest,
            reason: { ...this.session.approvalRequest.reason },
            affectedFiles: [...this.session.approvalRequest.affectedFiles],
          }
        : null,
      messages: this.session.messages.map((m) => ({ ...m })),
      logs: [...this.session.logs],
      diffSummary: { ...this.session.diffSummary },
    };
  }
}
