/**
 * `ClaudeCodeStreamProvider` (Phase 16) — drives ONE real Claude Code session
 * over the CLI's public stream-json interface
 * (`docs/PHASE16_REAL_AGENT_INTEGRATION.md` §4.1/§4.4).
 *
 * Deliberately a NEW class, not a `TerminalAgentProvider` subclass: that file
 * is the most-audited one in the repo and stays untouched in behavior. The
 * shared pieces (`envelope()`, `splitLines`, the line/log/byte caps,
 * `STOP_GRACE_MS`, `buildTerminalChildEnv`, the shutdown safety net) are
 * imported from it — one value each, never copied — and the mirrored
 * spawn/stop/limit plumbing is guarded by its own suite
 * (`tests/claude-stream-provider.test.ts`) asserting the same invariants.
 *
 * How it works:
 * - Spawns one long-lived `claude -p --input-format stream-json
 *   --output-format stream-json …` process per session (argv from the pure
 *   `buildClaudeArgv`; `shell: false`; env via `buildTerminalChildEnv` — the
 *   pairing token stays stripped — plus the two approval-bridge vars).
 * - Chat is DATA: `sendMessage` writes one `serializeUserMessage(text)` line
 *   to the child's stdin (never a shell, never re-parsed as a command); stdin
 *   is kept open on purpose (the spike showed `-p` waits on it — that's the
 *   multi-turn transport).
 * - stdout lines go through the pure parser/mapper
 *   (`claudeStreamParser.ts`), which scrubs every derived string; stderr and
 *   unparseable stdout lines go through a stateful `StreamScrubber` exactly
 *   like `TerminalAgentProvider` output. Ring buffer, per-line truncation and
 *   the per-session byte cap are identical.
 * - Approvals: a per-session `ApprovalBroker` + a random per-session bridge
 *   token. Claude Code's `--permission-prompt-tool` calls the MCP bridge
 *   script (`scripts/orbitory-approval-bridge.js`, referenced via a generated
 *   tmp `--mcp-config`), which POSTs to the loopback `/internal/approvals`
 *   endpoint; `resolveApproval` here settles the broker (NOT a no-op).
 *   Timeout denies. See `src/approvalBridge.ts` and `docs/security.md` §4.
 * - Exit 0 → `session.completed`; non-zero/signal → `session.failed` (unless
 *   the parser already failed the session with a nicer reason, e.g. the
 *   logged-out copy); `maxRuntimeSeconds` and stop (SIGTERM → SIGKILL after
 *   `STOP_GRACE_MS`) mirror `TerminalAgentProvider`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { TerminalAgentConfig } from "../agentConfig.js";
import {
  ApprovalBroker,
  approvalPendingSummary,
  DISPOSED_DENY_MESSAGE,
  generateBridgeToken,
  getInternalApprovalUrl,
  registerApprovalBridge,
} from "../approvalBridge.js";
import { PAIRING_TOKEN, PORT } from "../config.js";
import { scrubSecrets, StreamScrubber } from "../scrubbing.js";
import { describeSandbox, wrapCommandForSandbox } from "../sandbox.js";
import {
  buildTerminalChildEnv,
  envelope,
  MAX_SESSION_LOG_LINES,
  MAX_SESSION_OUTPUT_BYTES,
  MAX_TERMINAL_LINE_CHARS,
  registerActiveChild,
  splitLines,
  STOP_GRACE_MS,
  TRUNCATION_SUFFIX,
  unregisterActiveChild,
  type AgentProvider,
  type OutboundEnvelope,
  type StartSessionOptions,
} from "./AgentProvider.js";
import { presetCopy, type AgentPresetCopy } from "./agentPresets.js";
import {
  APPROVAL_PROMPT_TOOL_NAME,
  buildClaudeArgv,
  createStreamMapContext,
  mapEventToEmissions,
  parseClaudeStreamLine,
  type StreamEmission,
  type StreamMapContext,
} from "./claudeStreamParser.js";
import type {
  AgentSession,
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolvedPayload,
  ChangedFile,
  ChatMessage,
  Localized,
} from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Absolute path to the MCP approval-bridge script Claude Code spawns. */
const BRIDGE_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/orbitory-approval-bridge.js",
);

/**
 * Serialize one user chat message as a stream-json stdin line (§4.4). Pure
 * and exported for byte-exact tests: the trailing newline is part of the
 * wire format (one JSON event per line).
 */
export function serializeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

export class ClaudeCodeStreamProvider implements AgentProvider {
  readonly id = "claude-code-stream";
  readonly displayName: string;

  private readonly emitter = new EventEmitter();
  private session: AgentSession;
  private readonly config: TerminalAgentConfig;
  private child: ChildProcess | null = null;
  private stopped = false;
  private timedOut = false;
  private childExited = false;
  private detached = false;
  private terminalSequence = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stopTimer: NodeJS.Timeout | null = null;
  private runtimeTimer: NodeJS.Timeout | null = null;
  private emittedBytes = 0;
  private outputLimitReached = false;
  /** Directory holding the generated per-session MCP config; removed on exit/stop. */
  private mcpDir: string | null = null;
  private unregisterBridge: (() => void) | null = null;
  /** Status/summary to restore once a pending approval resolves. */
  private statusBeforeApproval: { status: AgentStatus; summary: Localized } | null = null;

  /** Per-session random bridge token (never logged, never sent to clients). */
  private readonly bridgeToken = generateBridgeToken();
  /**
   * Scrubber for DERIVED strings (the parser's boundary): pattern rules plus
   * the pairing token AND this session's bridge token as literals — if the
   * model or process ever echoes either, it is redacted before any emission.
   */
  private readonly scrub = (text: string): string =>
    scrubSecrets(text, [PAIRING_TOKEN, this.bridgeToken]);
  /**
   * Stateful scrubbers for RAW lines (stderr, unparseable stdout), so a PEM
   * block spanning streamed lines stays redacted — same posture as
   * `TerminalAgentProvider`, one scrubber per stream.
   */
  private readonly rawScrubbers = {
    stdout: new StreamScrubber([PAIRING_TOKEN, this.bridgeToken]),
    stderr: new StreamScrubber([PAIRING_TOKEN, this.bridgeToken]),
  } as const;
  private readonly mapCtx: StreamMapContext = createStreamMapContext(this.scrub);
  private readonly broker: ApprovalBroker;
  private readonly copy: AgentPresetCopy;

  private constructor(session: AgentSession, config: TerminalAgentConfig) {
    this.session = session;
    this.config = config;
    this.displayName = `Claude Code Stream (${config.displayName})`;
    this.copy = presetCopy(session.agentType, config.displayName);
    this.broker = new ApprovalBroker({
      timeoutMs: config.approvalTimeoutSeconds * 1000,
      scrub: this.scrub,
      onApprovalRequired: (request) => this.onApprovalRequired(request),
      onApprovalResolved: (payload) => this.onApprovalResolved(payload),
    });
  }

  /**
   * Create a provider for a brand-new session and immediately spawn the
   * process — same contract as the other providers' `forNewSession`:
   * `sessionStore` has already created the `AgentSession` and emits
   * `session.created` itself.
   */
  static forNewSession(
    initialSession: AgentSession,
    config: TerminalAgentConfig,
  ): ClaudeCodeStreamProvider {
    const provider = new ClaudeCodeStreamProvider(initialSession, config);
    provider.spawnProcess();
    return provider;
  }

  // -- AgentProvider surface -------------------------------------------------

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    if (opts.sessionId !== this.session.id) {
      throw new Error(
        `ClaudeCodeStreamProvider instance is bound to session ${this.session.id}, not ${opts.sessionId}`,
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

    // Chat is data on stdin — a stream-json user event, never a shell command.
    if (this.child && !this.child.killed && this.child.stdin && this.child.stdin.writable) {
      try {
        this.child.stdin.write(serializeUserMessage(text));
      } catch {
        // Best-effort, same as TerminalAgentProvider: an EPIPE here just means
        // this message wasn't delivered; it stays in chat history.
      }
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    if (this.stopped || this.isTerminal(this.session.status)) {
      return;
    }
    this.stopped = true;
    // Fail closed: anything still waiting on the phone is denied, and the
    // matching approval.resolved envelopes go out before the process dies.
    this.broker.disposeAll();
    // A SIGTERM-resistant child can still try to call the MCP permission bridge
    // during the grace window; unregister first so late requests fail closed.
    this.unregisterApprovalBridge();

    if (this.child && !this.childExited) {
      this.terminateWithEscalation();
    } else {
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

  /** REAL approval resolution (unlike TerminalAgentProvider): settles the broker. */
  resolveApproval(approvalId: string, decision: ApprovalDecision, allowSimilar?: boolean): boolean {
    return this.broker.resolveApproval(approvalId, decision, allowSimilar === true);
  }

  // -- Internal: process lifecycle -------------------------------------------

  private spawnProcess(): void {
    this.setStatus("planning", this.copy.starting);

    // Announce the effective sandbox + the approval mechanism as the first
    // terminal lines. Deferred to a microtask because forNewSession runs
    // before sessionStore subscribes (same reasoning as TerminalAgentProvider).
    queueMicrotask(() => {
      if (this.isTerminal(this.session.status)) return;
      this.emitTerminalLine(describeSandbox(this.config.sandbox), "stdout");
      this.emitTerminalLine("[orbitory] approval bridge: permission-prompt-tool", "stdout");
    });

    // Wire the approval bridge before spawning so a permission request racing
    // process startup can never miss its registration.
    let mcpConfigPath: string;
    try {
      mcpConfigPath = this.writeMcpConfig();
    } catch (err) {
      const message = scrubSecrets((err as Error).message, [PAIRING_TOKEN]);
      this.failSessionAfterSubscription({
        en: `Failed to prepare the approval bridge for ${this.config.displayName}: ${message}`,
        ja: `${this.config.displayName} の承認ブリッジを準備できませんでした: ${message}`,
      });
      return;
    }
    this.unregisterBridge = registerApprovalBridge({
      sessionId: this.session.id,
      token: this.bridgeToken,
      handle: ({ toolName, input }) => {
        if (this.stopped || this.timedOut || this.isTerminal(this.session.status)) {
          return Promise.resolve({ behavior: "deny", message: DISPOSED_DENY_MESSAGE });
        }
        return this.broker.request(toolName, input);
      },
    });

    const argv = buildClaudeArgv(this.config, randomUUID(), {
      toolName: APPROVAL_PROMPT_TOOL_NAME,
      mcpConfigPath,
    });
    // Container mode is rejected for io "stream-json" at config load (see
    // agentConfig.ts), so no containerOpts are ever needed here.
    const wrapped = wrapCommandForSandbox(
      this.config.command,
      argv,
      this.config.sandbox,
      this.config.workingDirectory,
    );
    this.detached = wrapped.detached;

    // Child env: the shared allowlist policy (pairing token ALWAYS stripped)
    // plus the two bridge vars this session's MCP tool needs. Values are
    // never logged.
    const childEnv: NodeJS.ProcessEnv = {
      ...buildTerminalChildEnv(this.config.envAllowlist),
      ORBITORY_APPROVAL_BRIDGE_URL: this.bridgeUrl(),
      ORBITORY_APPROVAL_BRIDGE_TOKEN: this.bridgeToken,
    };

    let child: ChildProcess;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd: this.config.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: childEnv,
        detached: wrapped.detached,
      });
    } catch (err) {
      const message = this.scrub((err as Error).message);
      this.cleanupBridge();
      this.failSessionAfterSubscription({
        en: `Failed to start ${this.config.displayName}: ${message}`,
        ja: `${this.config.displayName} の起動に失敗しました: ${message}`,
      });
      return;
    }

    this.child = child;
    registerActiveChild(child, this.detached && child.pid !== undefined ? { detachedGroupPid: child.pid } : undefined);

    this.runtimeTimer = setTimeout(() => {
      if (this.stopped || this.isTerminal(this.session.status)) return;
      this.timedOut = true;
      this.broker.disposeAll();
      this.unregisterApprovalBridge();
      this.terminateWithEscalation();
    }, this.config.maxRuntimeSeconds * 1000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk: string) => this.handleStderr(chunk));

    child.on("error", (err) => {
      this.childExited = true;
      unregisterActiveChild(child, child.pid);
      this.clearRuntimeTimer();
      this.cleanupBridge();
      if (this.isTerminal(this.session.status)) return;
      const message = this.scrub(err.message);
      this.failSession({
        en: `${this.config.displayName} could not be started or crashed: ${message}`,
        ja: `${this.config.displayName} を起動できないか、異常終了しました: ${message}`,
      });
    });

    child.on("exit", (code, signal) => {
      this.childExited = true;
      unregisterActiveChild(child, child.pid);
      this.clearRuntimeTimer();
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.flushRemainingBuffers();
      this.broker.disposeAll();
      this.cleanupBridge();

      if (this.stopped) {
        this.finalizeAsStoppedByUser();
        return;
      }

      if (this.timedOut) {
        if (this.isTerminal(this.session.status)) return;
        this.failSession({
          en: `${this.config.displayName} exceeded its maximum runtime (${this.config.maxRuntimeSeconds}s) and was terminated.`,
          ja: `${this.config.displayName} は最大実行時間（${this.config.maxRuntimeSeconds}秒）を超えたため終了されました。`,
        });
        return;
      }

      // The parser may already have failed the session with a more precise
      // reason (e.g. the logged-out copy from a result error); keep it.
      if (this.isTerminal(this.session.status)) return;

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

  /** Where the child's bridge script must POST. See approvalBridge.ts on TLS. */
  private bridgeUrl(): string {
    return getInternalApprovalUrl() ?? `http://127.0.0.1:${PORT}/internal/approvals`;
  }

  /**
   * Write the per-session `--mcp-config` file into a fresh 0700 tmp dir. It
   * references the bridge script by absolute path via the current Node
   * executable, and carries the bridge env explicitly so the tool works
   * regardless of how Claude Code builds its MCP child environments. The file
   * is 0600 and the dir is removed on stop/exit; the token in it is this
   * session's random bridge token, NOT the pairing token.
   */
  private writeMcpConfig(): string {
    this.mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-mcp-"));
    const configPath = path.join(this.mcpDir, "mcp-config.json");
    const config = {
      mcpServers: {
        orbitory: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT_PATH],
          env: {
            ORBITORY_APPROVAL_BRIDGE_URL: this.bridgeUrl(),
            ORBITORY_APPROVAL_BRIDGE_TOKEN: this.bridgeToken,
          },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    return configPath;
  }

  /** Unregister the loopback route entry + remove the tmp MCP config dir. */
  private cleanupBridge(): void {
    this.unregisterApprovalBridge();
    if (this.mcpDir !== null) {
      try {
        fs.rmSync(this.mcpDir, { recursive: true, force: true });
      } catch {
        // Best-effort; it's a 0700 tmp dir either way.
      }
      this.mcpDir = null;
    }
  }

  private unregisterApprovalBridge(): void {
    if (!this.unregisterBridge) return;
    this.unregisterBridge();
    this.unregisterBridge = null;
  }

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
        // Group already gone — fall through to a direct kill.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private terminateWithEscalation(): void {
    this.terminateChild("SIGTERM");
    this.stopTimer = setTimeout(() => {
      if (this.childExited) return;
      this.terminateChild("SIGKILL");
    }, STOP_GRACE_MS);
  }

  // -- Internal: stream handling ----------------------------------------------

  private handleStdout(chunk: string): void {
    const { lines, remainder } = splitLines(this.stdoutBuffer, chunk);
    this.stdoutBuffer = remainder;
    for (const line of lines) {
      this.processStreamLine(line);
    }
  }

  private handleStderr(chunk: string): void {
    const { lines, remainder } = splitLines(this.stderrBuffer, chunk);
    this.stderrBuffer = remainder;
    for (const line of lines) {
      this.emitRawLine(line, "stderr");
    }
  }

  private flushRemainingBuffers(): void {
    if (this.stdoutBuffer.length > 0) {
      this.processStreamLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
    if (this.stderrBuffer.length > 0) {
      this.emitRawLine(this.stderrBuffer, "stderr");
      this.stderrBuffer = "";
    }
  }

  /** Scrub (stateful, PEM-aware) + truncate + emit one RAW process line. */
  private emitRawLine(rawLine: string, stream: "stdout" | "stderr"): void {
    if (rawLine.length === 0) return;
    const scrubbed = this.rawScrubbers[stream].scrubLine(rawLine);
    this.emitTerminalLine(this.truncateLine(scrubbed), stream);
  }

  private processStreamLine(rawLine: string): void {
    if (rawLine.trim().length === 0) return;
    const event = parseClaudeStreamLine(rawLine);
    if (event.kind === "unparseable") {
      // Raw passthrough via the STATEFUL stdout scrubber (better cross-line
      // PEM handling than the mapper's pure scrub) — never swallowed.
      this.emitRawLine(rawLine, "stdout");
      return;
    }
    for (const emission of mapEventToEmissions(event, this.mapCtx)) {
      this.applyEmission(emission);
    }
  }

  private applyEmission(emission: StreamEmission): void {
    // A failed/completed session's state never regresses; trailing terminal
    // lines may still land in the log for postmortem value.
    if (this.isTerminal(this.session.status) && emission.type !== "terminalLine") {
      return;
    }

    switch (emission.type) {
      case "status":
        // While an approval is pending, remember the newest underlying status
        // instead of clobbering approvalNeeded on the wire.
        if (this.session.status === "approvalNeeded" && this.statusBeforeApproval) {
          this.statusBeforeApproval = { status: emission.status, summary: emission.summary };
          return;
        }
        this.setStatus(emission.status, emission.summary);
        return;

      case "chat": {
        const message: ChatMessage = {
          id: `msg_${randomUUID()}`,
          role: "assistant",
          text: emission.text,
          timestamp: nowIso(),
        };
        this.session.messages.push(message);
        this.session.updatedAt = nowIso();
        this.emit(
          envelope("chat.message", this.session.id, {
            messageId: message.id,
            role: "assistant",
            text: emission.text,
          }),
        );
        this.emitSessionUpdated();
        return;
      }

      case "terminalLine":
        this.emitTerminalLine(this.truncateLine(emission.text), emission.stream);
        return;

      case "fileChanged":
        this.applyFileChange(emission.file);
        return;

      case "testsStarted":
        this.session.testStatus = {
          status: "running",
          passedCount: 0,
          failedCount: 0,
          durationSeconds: 0,
          summary: emission.summary,
        };
        this.session.updatedAt = nowIso();
        this.emit(envelope("tests.started", this.session.id, { testStatus: this.session.testStatus }));
        return;

      case "testsFinished":
        this.session.testStatus = emission.result;
        this.session.updatedAt = nowIso();
        this.emit(envelope("tests.finished", this.session.id, { testStatus: emission.result }));
        return;

      case "sessionFailed":
        if (this.isTerminal(this.session.status)) return;
        this.broker.disposeAll();
        this.unregisterApprovalBridge();
        this.failSession(emission.reason);
        return;
    }
  }

  private applyFileChange(file: ChangedFile): void {
    const existingIndex = this.session.changedFiles.findIndex((f) => f.path === file.path);
    if (existingIndex >= 0) {
      this.session.changedFiles[existingIndex] = file;
    } else {
      this.session.changedFiles.push(file);
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
        changedFiles: this.session.changedFiles.map((f) => ({ ...f, summary: { ...f.summary } })),
        diffSummary: this.session.diffSummary,
      }),
    );
  }

  // -- Internal: approvals ------------------------------------------------------

  private onApprovalRequired(request: ApprovalRequest): void {
    if (this.isTerminal(this.session.status)) return;
    if (this.session.status !== "approvalNeeded") {
      this.statusBeforeApproval = {
        status: this.session.status,
        summary: { ...this.session.currentSummary },
      };
    }
    this.session.status = "approvalNeeded";
    this.session.approvalRequired = true;
    this.session.approvalRequest = request;
    this.session.currentSummary = approvalPendingSummary(request.command);
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

  private onApprovalResolved(payload: ApprovalResolvedPayload): void {
    this.emit(envelope("approval.resolved", this.session.id, payload));
    if (this.isTerminal(this.session.status)) return;

    this.session.approvalRequired = false;
    this.session.approvalRequest = null;
    this.session.updatedAt = nowIso();

    // Restore whatever the session was doing before the approval (only when
    // no OTHER approval is still pending on the broker).
    if (this.broker.pendingCount === 0 && this.session.status === "approvalNeeded") {
      const prior = this.statusBeforeApproval ?? {
        status: "editing" as AgentStatus,
        summary: this.copy.running,
      };
      this.statusBeforeApproval = null;
      this.setStatus(prior.status, prior.summary);
    }
  }

  // -- Internal: state + emit helpers -------------------------------------------

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

  /** Same microtask rationale as TerminalAgentProvider.failSessionAfterSubscription. */
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
    this.session.currentSummary = this.copy.completed;
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("session.completed", this.session.id, {
        summary: this.copy.completed,
        changedFileCount: this.session.changedFileCount,
        testStatus: { ...this.session.testStatus, summary: { ...this.session.testStatus.summary } },
      }),
    );
  }

  private setStatus(status: AgentStatus, summary: Localized): void {
    this.session.status = status;
    this.session.currentSummary = summary;
    this.session.updatedAt = nowIso();
    this.emit(envelope("agent.status.changed", this.session.id, { status, currentSummary: summary }));
  }

  private truncateLine(line: string): string {
    return line.length > MAX_TERMINAL_LINE_CHARS
      ? line.slice(0, MAX_TERMINAL_LINE_CHARS) + TRUNCATION_SUFFIX
      : line;
  }

  /** Ring buffer + per-session byte cap, mirroring TerminalAgentProvider. */
  private emitTerminalLine(line: string, stream: "stdout" | "stderr"): void {
    if (this.outputLimitReached) {
      return;
    }
    this.pushTerminalLine(line, stream);
    this.emittedBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.emittedBytes > MAX_SESSION_OUTPUT_BYTES) {
      this.outputLimitReached = true;
      this.pushTerminalLine(
        "[orbitory] per-session output limit reached; further output is suppressed (the process keeps running).",
        "stdout",
      );
    }
  }

  private pushTerminalLine(line: string, stream: "stdout" | "stderr"): void {
    this.session.logs.push(line);
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
        `ClaudeCodeStreamProvider instance is bound to session ${this.session.id}, not ${sessionId}`,
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
