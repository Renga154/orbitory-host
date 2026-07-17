/** Multi-turn Codex provider backed by short-lived public `codex exec` turns. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { TerminalAgentConfig } from "../agentConfig.js";
import type { ResolvedProviderSelection } from "../providerControls.js";
import { PAIRING_TOKEN } from "../config.js";
import { REDACTED, scrubSecrets, StreamScrubber } from "../scrubbing.js";
import {
  agentStateWritablePaths,
  ENV_NAME_PATTERN,
  wrapCommandForSandbox,
} from "../sandbox.js";
import type {
  AgentSession,
  AgentStatus,
  ApprovalDecision,
  ChatMessage,
  Localized,
  TerminalStream,
} from "../types.js";
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
import {
  buildCodexExecArgv,
  classifyCodexFailureText,
  parseCodexExecLine,
} from "./codexExecParser.js";

function nowIso(): string {
  return new Date().toISOString();
}

const WAITING_SUMMARY: Localized = {
  en: "Waiting for your next message.",
  ja: "次のメッセージを待っています。",
};

const STARTING_TURN_SUMMARY: Localized = {
  en: "Starting a Codex turn.",
  ja: "Codex のターンを開始しています。",
};

const WORKING_SUMMARY: Localized = {
  en: "Codex is working.",
  ja: "Codex が作業しています。",
};

const RETRY_TURN_SUMMARY: Localized = {
  en: "This Codex turn failed. The session is still available; retry your message.",
  ja: "Codex のこのターンは失敗しました。セッションは引き続き利用できます。メッセージを再送してください。",
};

const REDACTED_PATH = "[REDACTED_PATH]";

interface ActiveTurn {
  child: ChildProcess;
  detached: boolean;
  containerName: string | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  sawTurnCompleted: boolean;
  eventFailed: boolean;
  privateFailureReason?: Localized;
  recoverableFailureReason?: Localized;
  timedOut: boolean;
  finalized: boolean;
  receivedBytes: number;
  runtimeTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  rawScrubbers: {
    stdout: StreamScrubber;
    stderr: StreamScrubber;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactAbsolutePaths(text: string): string {
  return text
    .replace(
      /(^|[\s("'`=])\/(?:[^/\s"'`<>:]+\/)*[^/\s"'`<>:,;)}\]]+/gmu,
      `$1${REDACTED_PATH}`,
    )
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`<>:]+\\)*[^\\\s"'`<>:,;)}\]]+/gu, REDACTED_PATH)
    .replace(
      /(^|[\s("'`=])(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+/gmu,
      `$1${REDACTED_PATH}`,
    );
}

export class CodexExecProvider implements AgentProvider {
  readonly id = "codex-exec";
  readonly displayName: string;

  private readonly emitter = new EventEmitter();
  private session: AgentSession;
  private readonly pendingMessages: string[] = [];
  private threadId: string | undefined;
  private activeTurn: ActiveTurn | null = null;
  private stopped = false;
  private turnCounter = 0;
  private terminalSequence = 0;
  private emittedBytes = 0;
  private outputLimitReached = false;

  private constructor(
    session: AgentSession,
    private readonly config: TerminalAgentConfig,
    threadId?: string,
    private readonly selection?: ResolvedProviderSelection,
  ) {
    this.session = session;
    this.threadId = threadId;
    this.displayName = `Codex Exec (${config.displayName})`;
  }

  static forNewSession(
    initialSession: AgentSession,
    config: TerminalAgentConfig,
    threadId?: string,
    selection?: ResolvedProviderSelection,
  ): CodexExecProvider {
    const provider = new CodexExecProvider(initialSession, config, threadId, selection);
    queueMicrotask(() => {
      if (
        !provider.activeTurn &&
        provider.pendingMessages.length === 0 &&
        !provider.stopped &&
        !provider.isTerminal(provider.session.status)
      ) {
        provider.setStatus("idle", WAITING_SUMMARY);
      }
    });
    return provider;
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    this.assertSession(opts.sessionId);
    return this.cloneSession();
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

    if (this.stopped || this.isTerminal(this.session.status)) return;
    this.pendingMessages.push(text);
    this.startNextTurn();
  }

  async stopSession(sessionId: string): Promise<void> {
    this.assertSession(sessionId);
    if (this.stopped || this.isTerminal(this.session.status)) return;
    this.stopped = true;
    this.pendingMessages.length = 0;

    if (this.activeTurn) {
      this.terminateWithEscalation(this.activeTurn);
    } else {
      this.failSession({ en: "Stopped by user.", ja: "ユーザーによって停止されました。" });
    }
  }

  getStatus(sessionId: string): AgentSession | undefined {
    return sessionId === this.session.id ? this.cloneSession() : undefined;
  }

  streamEvents(onEvent: (envelope: OutboundEnvelope) => void): void {
    this.emitter.on("event", onEvent);
  }

  resolveApproval(
    _approvalId: string,
    _decision: ApprovalDecision,
    _allowSimilar?: boolean,
  ): boolean {
    return false;
  }

  private framePrompt(text: string): string {
    const toolInstruction = this.selection?.includesSkills
      ? "Use the project's host-configured Skills when they are relevant.\n\n"
      : "";
    if (this.selection?.permissionMode === "observe") {
      return [
        "Orbitory observe access: inspect and explain only. Do not modify files or run write-capable commands.",
        "",
        toolInstruction + text,
      ].join("\n");
    }
    switch (this.selection?.intent) {
      case "plan":
        return [
          "Orbitory plan mode: analyze and produce a concrete plan only. Do not modify files or run write-capable commands.",
          "",
          toolInstruction + text,
        ].join("\n");
      case "review":
        return [
          "Orbitory review mode: inspect the current project and report correctness, security, and test gaps. Do not modify files.",
          "",
          toolInstruction + text,
        ].join("\n");
      default:
        return toolInstruction + text;
    }
  }

  private startNextTurn(): void {
    if (
      this.activeTurn ||
      this.stopped ||
      this.isTerminal(this.session.status) ||
      this.pendingMessages.length === 0
    ) {
      return;
    }

    const prompt = this.framePrompt(this.pendingMessages.shift()!);
    this.turnCounter += 1;
    this.setStatus("planning", STARTING_TURN_SUMMARY);
    this.emitTerminalLine(
      `[orbitory] Codex turn ${this.turnCounter} started (sandbox ${this.config.sandbox.effectiveMode}).`,
      "stdout",
    );

    const argv = buildCodexExecArgv(this.config, this.threadId, this.selection);
    const isContainer = this.config.sandbox.effectiveMode === "container";
    if (isContainer && !this.config.sandbox.container) {
      this.failSession({
        en: "Codex has an invalid container sandbox configuration and was not started.",
        ja: "Codex のコンテナサンドボックス設定が不正なため、起動しませんでした。",
      });
      return;
    }

    const containerName = isContainer
      ? `orbitory-${this.session.id}-${this.turnCounter}`.replace(/[^A-Za-z0-9_.-]/g, "-")
      : null;
    let wrapped: ReturnType<typeof wrapCommandForSandbox>;
    try {
      wrapped = wrapCommandForSandbox(
        this.config.command,
        argv,
        this.config.sandbox,
        this.config.workingDirectory,
        isContainer && containerName
          ? {
              envPassthroughKeys: this.containerEnvPassthroughKeys(),
              containerName,
            }
          : undefined,
        agentStateWritablePaths("codex"),
      );
    } catch {
      this.failSession({
        en: "Codex could not be prepared for launch.",
        ja: "Codex の起動準備に失敗しました。",
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd: this.config.workingDirectory,
        env: isContainer
          ? buildTerminalChildEnv(undefined)
          : buildTerminalChildEnv(this.config.envAllowlist),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: wrapped.detached,
      });
    } catch {
      this.failSession({
        en: "Codex could not be started.",
        ja: "Codex を起動できませんでした。",
      });
      return;
    }

    const literalSecrets = [PAIRING_TOKEN, ...(this.threadId ? [this.threadId] : [])];
    const turn: ActiveTurn = {
      child,
      detached: wrapped.detached,
      containerName,
      stdoutBuffer: "",
      stderrBuffer: "",
      sawTurnCompleted: false,
      eventFailed: false,
      timedOut: false,
      finalized: false,
      receivedBytes: 0,
      runtimeTimer: null,
      stopTimer: null,
      rawScrubbers: {
        stdout: new StreamScrubber(literalSecrets),
        stderr: new StreamScrubber(literalSecrets),
      },
    };
    this.activeTurn = turn;
    registerActiveChild(
      child,
      wrapped.detached && child.pid !== undefined ? { detachedGroupPid: child.pid } : undefined,
    );

    turn.runtimeTimer = setTimeout(() => {
      if (turn.finalized || this.stopped || this.isTerminal(this.session.status)) return;
      turn.timedOut = true;
      this.terminateWithEscalation(turn);
    }, this.config.maxRuntimeSeconds * 1000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleChunk(turn, chunk, "stdout"));
    child.stderr?.on("data", (chunk: string) => this.handleChunk(turn, chunk, "stderr"));
    child.stdin?.on("error", () => {
      // The close/error path below owns session failure; prevent an unhandled EPIPE.
    });

    child.on("error", () => {
      if (turn.finalized || this.isTerminal(this.session.status)) return;
      turn.eventFailed = true;
      this.failSession({
        en: "Codex could not be started or crashed.",
        ja: "Codex を起動できないか、異常終了しました。",
      });
      this.terminateWithEscalation(turn);
    });

    child.on("close", (code, signal) => this.finishTurn(turn, code, signal));

    try {
      child.stdin?.end(prompt);
    } catch {
      turn.eventFailed = true;
      this.failSession({
        en: "The Codex prompt could not be delivered.",
        ja: "Codex にプロンプトを送信できませんでした。",
      });
      this.terminateWithEscalation(turn);
    }
  }

  private handleChunk(turn: ActiveTurn, chunk: string, stream: TerminalStream): void {
    if (turn.finalized) return;
    turn.receivedBytes += Buffer.byteLength(chunk, "utf8");
    if (turn.receivedBytes > MAX_SESSION_OUTPUT_BYTES) {
      if (!turn.eventFailed) {
        turn.eventFailed = true;
        this.failSession({
          en: "Codex output exceeded the session safety limit.",
          ja: "Codex の出力がセッションの安全上限を超えました。",
        });
        this.terminateWithEscalation(turn);
      }
      return;
    }

    if (stream === "stdout") {
      const split = splitLines(turn.stdoutBuffer, chunk);
      turn.stdoutBuffer = split.remainder;
      split.lines.forEach((line) => this.processStdoutLine(turn, line));
    } else {
      const split = splitLines(turn.stderrBuffer, chunk);
      turn.stderrBuffer = split.remainder;
      split.lines.forEach((line) => this.consumePrivateRawLine(turn, line, "stderr"));
    }
  }

  private processStdoutLine(turn: ActiveTurn, rawLine: string): void {
    if (rawLine.trim().length === 0) return;
    const event = parseCodexExecLine(rawLine);

    if (event.kind === "threadStarted") {
      if (this.threadId === undefined && event.threadId.length > 0) {
        this.threadId = event.threadId;
      }
      return;
    }
    if (event.kind === "ignored") {
      this.consumePrivateRawLine(turn, rawLine, "stdout");
      return;
    }
    if (this.isTerminal(this.session.status)) return;

    switch (event.kind) {
      case "turnStarted":
        this.setStatus("planning", WORKING_SUMMARY);
        return;
      case "turnCompleted":
        turn.sawTurnCompleted = true;
        return;
      case "turnFailed":
      case "processError":
        turn.eventFailed = true;
        turn.privateFailureReason = classifyCodexFailureText(this.scrubProcessText(event.message));
        if (this.threadId && !turn.privateFailureReason) {
          this.pendingMessages.length = 0;
          turn.recoverableFailureReason = RETRY_TURN_SUMMARY;
          this.terminateWithEscalation(turn);
          return;
        }
        this.failSession(
          turn.privateFailureReason ?? {
            en: "The Codex turn failed.",
            ja: "Codex のターンが失敗しました。",
          },
        );
        this.terminateWithEscalation(turn);
        return;
      case "assistantMessage":
        this.appendAssistantMessage(event.text);
        return;
      case "status":
        this.setStatus(event.status, event.summary);
        return;
    }
  }

  /** Scrub every raw line even though it intentionally stays host-only. */
  private consumePrivateRawLine(
    turn: ActiveTurn,
    rawLine: string,
    stream: TerminalStream,
  ): void {
    const scrubbed = turn.rawScrubbers[stream].scrubLine(rawLine);
    const privateText = this.scrubProcessText(scrubbed);
    turn.privateFailureReason ??= classifyCodexFailureText(privateText);
  }

  private flushBuffers(turn: ActiveTurn): void {
    if (turn.stdoutBuffer.length > 0) {
      this.processStdoutLine(turn, turn.stdoutBuffer);
      turn.stdoutBuffer = "";
    }
    if (turn.stderrBuffer.length > 0) {
      this.consumePrivateRawLine(turn, turn.stderrBuffer, "stderr");
      turn.stderrBuffer = "";
    }
  }

  private finishTurn(
    turn: ActiveTurn,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (turn.finalized) return;
    this.flushBuffers(turn);
    turn.finalized = true;
    this.clearTurnTimers(turn);
    unregisterActiveChild(
      turn.child,
      turn.detached && turn.child.pid !== undefined ? turn.child.pid : undefined,
    );
    if (this.activeTurn === turn) this.activeTurn = null;

    if (this.stopped) {
      if (!this.isTerminal(this.session.status)) {
        this.failSession({ en: "Stopped by user.", ja: "ユーザーによって停止されました。" });
      }
      return;
    }
    if (turn.timedOut) {
      if (!this.isTerminal(this.session.status)) {
        this.failSession({
          en: `Codex exceeded its maximum turn runtime (${this.config.maxRuntimeSeconds}s) and was terminated.`,
          ja: `Codex はターンの最大実行時間（${this.config.maxRuntimeSeconds}秒）を超えたため終了されました。`,
        });
      }
      return;
    }
    if (turn.recoverableFailureReason && !this.isTerminal(this.session.status)) {
      this.setStatus("idle", turn.recoverableFailureReason);
      return;
    }
    if (turn.eventFailed || this.isTerminal(this.session.status)) return;
    if (code !== 0 || signal !== null) {
      if (this.threadId && !turn.privateFailureReason && signal === null) {
        this.pendingMessages.length = 0;
        this.setStatus("idle", RETRY_TURN_SUMMARY);
        return;
      }
      this.failSession(
        turn.privateFailureReason ?? {
          en: signal ? `Codex was terminated by signal ${signal}.` : `Codex exited with code ${code}.`,
          ja: signal
            ? `Codex はシグナル ${signal} により終了しました。`
            : `Codex はコード ${code} で終了しました。`,
        },
      );
      return;
    }
    if (!turn.sawTurnCompleted || !this.threadId) {
      this.failSession({
        en: "Codex ended without a complete resumable turn.",
        ja: "Codex が再開可能なターンを完了せずに終了しました。",
      });
      return;
    }

    this.setStatus("idle", WAITING_SUMMARY);
    if (this.pendingMessages.length > 0) {
      queueMicrotask(() => this.startNextTurn());
    }
  }

  private terminateChild(turn: ActiveTurn, signal: NodeJS.Signals): void {
    if (turn.finalized || turn.child.pid === undefined) return;
    if (turn.detached) {
      try {
        process.kill(-turn.child.pid, signal);
        return;
      } catch {
        // The group may already be gone; fall through to direct signalling.
      }
    }
    try {
      turn.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private terminateWithEscalation(turn: ActiveTurn): void {
    this.terminateChild(turn, "SIGTERM");
    if (turn.stopTimer) return;
    turn.stopTimer = setTimeout(() => {
      if (turn.finalized) return;
      this.terminateChild(turn, "SIGKILL");
      this.removeContainerBestEffort(turn);
    }, STOP_GRACE_MS);
  }

  private removeContainerBestEffort(turn: ActiveTurn): void {
    const container = this.config.sandbox.container;
    if (!container || !turn.containerName) return;
    try {
      const cleanup = spawn(container.engineExecutable, ["rm", "-f", turn.containerName], {
        stdio: "ignore",
        detached: true,
      });
      cleanup.on("error", () => {});
      cleanup.unref();
    } catch {
      // Best-effort cleanup only.
    }
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    if (turn.runtimeTimer) clearTimeout(turn.runtimeTimer);
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
    turn.runtimeTimer = null;
    turn.stopTimer = null;
  }

  private containerEnvPassthroughKeys(): string[] {
    return (this.config.envAllowlist ?? []).filter(
      (key) =>
        key !== "ORBITORY_PAIRING_TOKEN" &&
        ENV_NAME_PATTERN.test(key) &&
        process.env[key] !== undefined,
    );
  }

  private appendAssistantMessage(rawText: string): void {
    const text = this.truncateLine(this.scrubProcessText(rawText)).trim();
    if (text.length === 0 || this.outputLimitReached) return;

    const message: ChatMessage = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      text,
      timestamp: nowIso(),
    };
    this.session.messages.push(message);
    this.session.updatedAt = nowIso();
    this.emittedBytes += Buffer.byteLength(text, "utf8") + 1;
    this.emit(
      envelope("chat.message", this.session.id, {
        messageId: message.id,
        role: "assistant",
        text,
      }),
    );
    this.emitSessionUpdated();
    this.checkEmittedOutputLimit();
  }

  private scrubProcessText(text: string): string {
    let scrubbed = scrubSecrets(text, [
      PAIRING_TOKEN,
      ...(this.threadId ? [this.threadId] : []),
    ]);
    for (const privatePath of [this.config.workingDirectory, process.env.HOME]) {
      if (privatePath && privatePath.length >= 2) {
        scrubbed = scrubbed.replace(new RegExp(escapeRegExp(privatePath), "g"), REDACTED_PATH);
      }
    }
    return redactAbsolutePaths(scrubbed).replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      REDACTED,
    );
  }

  private truncateLine(line: string): string {
    return line.length > MAX_TERMINAL_LINE_CHARS
      ? line.slice(0, MAX_TERMINAL_LINE_CHARS) + TRUNCATION_SUFFIX
      : line;
  }

  private emitTerminalLine(rawLine: string, stream: TerminalStream): void {
    if (this.outputLimitReached) return;
    const line = this.truncateLine(rawLine);
    this.session.logs.push(line);
    if (this.session.logs.length > MAX_SESSION_LOG_LINES) {
      this.session.logs.splice(0, this.session.logs.length - MAX_SESSION_LOG_LINES);
    }
    this.terminalSequence += 1;
    this.emittedBytes += Buffer.byteLength(line, "utf8") + 1;
    this.emit(
      envelope("terminal.output", this.session.id, {
        stream,
        text: line,
        sequence: this.terminalSequence,
      }),
    );
    this.checkEmittedOutputLimit();
  }

  private checkEmittedOutputLimit(): void {
    if (this.outputLimitReached || this.emittedBytes <= MAX_SESSION_OUTPUT_BYTES) return;
    this.outputLimitReached = true;
    const notice = "[orbitory] per-session output limit reached; further output is suppressed.";
    this.session.logs.push(notice);
    if (this.session.logs.length > MAX_SESSION_LOG_LINES) this.session.logs.shift();
    this.terminalSequence += 1;
    this.emit(
      envelope("terminal.output", this.session.id, {
        stream: "stdout",
        text: notice,
        sequence: this.terminalSequence,
      }),
    );
  }

  private failSession(reason: Localized): void {
    if (this.isTerminal(this.session.status)) return;
    this.pendingMessages.length = 0;
    this.session.status = "failed";
    this.session.currentSummary = { ...reason };
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

  private setStatus(status: AgentStatus, summary: Localized): void {
    if (this.isTerminal(this.session.status)) return;
    this.session.status = status;
    this.session.currentSummary = { ...summary };
    this.session.updatedAt = nowIso();
    this.emit(
      envelope("agent.status.changed", this.session.id, {
        status,
        currentSummary: this.session.currentSummary,
      }),
    );
  }

  private emitSessionUpdated(): void {
    this.emit(envelope("session.updated", this.session.id, { updatedAt: this.session.updatedAt }));
  }

  private emit(event: OutboundEnvelope): void {
    this.emitter.emit("event", event);
  }

  private isTerminal(status: AgentStatus): boolean {
    return status === "completed" || status === "failed";
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.session.id) {
      throw new Error(
        `CodexExecProvider instance is bound to session ${this.session.id}, not ${sessionId}`,
      );
    }
  }

  private cloneSession(): AgentSession {
    return {
      ...this.session,
      currentSummary: { ...this.session.currentSummary },
      changedFiles: this.session.changedFiles.map((file) => ({
        ...file,
        summary: { ...file.summary },
      })),
      testStatus: {
        ...this.session.testStatus,
        summary: { ...this.session.testStatus.summary },
      },
      approvalRequest: this.session.approvalRequest
        ? {
            ...this.session.approvalRequest,
            reason: { ...this.session.approvalRequest.reason },
            affectedFiles: [...this.session.approvalRequest.affectedFiles],
          }
        : null,
      messages: this.session.messages.map((message) => ({ ...message })),
      logs: [...this.session.logs],
      diffSummary: { ...this.session.diffSummary },
    };
  }
}
