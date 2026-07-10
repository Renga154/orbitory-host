/**
 * WebSocket transport for the Orbitory host-agent.
 *
 * Registers a single `/ws` route on a Fastify instance (via
 * `@fastify/websocket`) that implements the realtime, bidirectional
 * protocol described in docs/protocol.md: pairing-token handshake,
 * `server.hello` + `session.snapshot` on success, live forwarding of every
 * sessionStore event as a JSON text frame, and dispatch of incoming
 * client messages to the corresponding sessionStore method.
 */

import * as os from "node:os";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import { DEMO_SESSIONS_ENABLED, HELLO_TIMEOUT_MS } from "./config.js";
import { verifyPresentedToken } from "./auth.js";
import {
  getAuditStore,
  recordAuthFailed,
  recordProviderStartRejected,
  recordProviderStartRequested,
  recordSessionStopRequested,
} from "./audit.js";
import { redactToken } from "./logging.js";
import { sessionStore } from "./sessionStore.js";
import type {
  ApprovalDecision,
  ClientMessage,
  Envelope,
  ErrorPayload,
  ServerMessage,
} from "./types.js";

/** Reported in `server.hello`; purely informational, not a security boundary. */
export const SERVER_VERSION = "0.1.0";

/** Reported in `server.hello.capabilities`; mirrors the event types this server actually emits. */
const SERVER_CAPABILITIES = [
  "chat",
  "approvals",
  "diffs",
  "terminalOutput",
  "testResults",
  "auditLog",
];

function serverCapabilities(): string[] {
  return DEMO_SESSIONS_ENABLED ? [...SERVER_CAPABILITIES, "demoSessions"] : SERVER_CAPABILITIES;
}

/** WebSocket close code used for authentication failures. */
const CLOSE_CODE_UNAUTHORIZED = 4401;

function nowIso(): string {
  return new Date().toISOString();
}

function makeEnvelope<T>(
  type: string,
  sessionId: string | null,
  payload: T,
): Envelope<T> {
  return {
    type,
    version: 1,
    timestamp: nowIso(),
    sessionId,
    payload,
  };
}

function sendEnvelope(socket: WebSocket, envelope: Envelope<unknown>): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(envelope));
  } catch (err) {
    // Best-effort; if serialization/send fails there's nothing more we can
    // do for this frame. Swallow to avoid crashing the process.
    console.error("[orbitory-host-agent] Failed to send WS frame:", err);
  }
}

/**
 * `recoverable` per known `code`, matching the table in docs/protocol.md
 * section 7 ("Error handling"). Connection-level auth/protocol failures are
 * not recoverable (the client must fix credentials/version and reconnect);
 * session-scoped operational errors are recoverable (the client can just
 * ignore/retry and the connection stays open). `internal_error` is
 * recoverable per the doc's table (an unexpected one-off server hiccup, not
 * a reason to give up on the connection).
 */
const NON_RECOVERABLE_ERROR_CODES = new Set([
  "unauthorized",
  "handshake_timeout",
  "unsupported_version",
  "unknown_session",
  "invalid_payload",
  "unknown_event_type",
  "approval_not_found",
]);

function recoverableForCode(code: string): boolean {
  return !NON_RECOVERABLE_ERROR_CODES.has(code);
}

function sendError(
  socket: WebSocket,
  sessionId: string | null,
  code: string,
  message: string,
): void {
  const payload: ErrorPayload = { code, message, recoverable: recoverableForCode(code) };
  sendEnvelope(socket, makeEnvelope("error", sessionId, payload));
}

function extractTokenFromQuery(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const raw = query?.["token"];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Registers the `/ws` route on the given Fastify instance. Assumes
 * `@fastify/websocket` has already been registered on `app` (done in
 * server.ts).
 */
export function registerWebSocketRoute(app: FastifyInstance): void {
  app.get(
    "/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      handleConnection(socket, request).catch((err) => {
        console.error(
          "[orbitory-host-agent] Unexpected error handling WS connection:",
          err,
        );
        try {
          socket.close();
        } catch {
          // ignore
        }
      });
    },
  );
}

async function handleConnection(
  socket: WebSocket,
  request: FastifyRequest,
): Promise<void> {
  const queryToken = extractTokenFromQuery(request);

  const { token, timedOut } = await resolveToken(socket, queryToken);

  // docs/protocol.md section 7 distinguishes "handshake_timeout" (no valid
  // client.hello arrived in time) from "unauthorized" (a hello did arrive,
  // but its token was missing or wrong) as separate error codes, even
  // though both close the socket the same way (code 4401, reason
  // "unauthorized", per section 3).
  if (timedOut) {
    console.warn(
      "[orbitory-host-agent] WS handshake timed out waiting for client.hello; closing connection.",
    );
    sendError(
      socket,
      null,
      "handshake_timeout",
      "Timed out waiting for client.hello with a pairing token.",
    );
    socket.close(CLOSE_CODE_UNAUTHORIZED, "unauthorized");
    return;
  }

  const auth = verifyPresentedToken(token);
  if (!auth.ok) {
    console.warn(
      `[orbitory-host-agent] WS auth failed (${auth.reason}) for token ${redactToken(
        token,
      )}; closing connection.`,
    );
    // Phase 10: audit the auth failure (reason code only — never the token).
    recordAuthFailed(`ws:${auth.reason}`);
    sendError(
      socket,
      null,
      "unauthorized",
      "Invalid or missing pairing token.",
    );
    socket.close(CLOSE_CODE_UNAUTHORIZED, "unauthorized");
    return;
  }

  const authDetail = auth.kind === "device" ? `device ${auth.record.id}` : "static token";
  console.log(
    `[orbitory-host-agent] WS client authenticated (${authDetail}, token ${redactToken(
      token,
    )}).`,
  );

  // Handshake succeeded: greet the client, then hand off to the steady-state
  // message loop for the remainder of the connection's lifetime.
  sendEnvelope(
    socket,
    makeEnvelope("server.hello", null, {
      serverName: "orbitory-host-agent" as const,
      serverVersion: SERVER_VERSION,
      protocolVersion: 1 as const,
      hostId: os.hostname(),
      capabilities: serverCapabilities(),
    }),
  );

  sendEnvelope(
    socket,
    makeEnvelope("session.snapshot", null, {
      hosts: sessionStore.getHosts(),
      sessions: sessionStore.getSessionsSnapshot(),
    }),
  );

  // Phase 6: the sanitized provider list, sent once right after the session
  // snapshot on a successful handshake (and again on `providers.request`).
  sendEnvelope(
    socket,
    makeEnvelope("providers.snapshot", null, {
      providers: sessionStore.getProviderDescriptors(),
    }),
  );

  // Phase 10: recent audit events, sent once after the provider snapshot.
  sendEnvelope(
    socket,
    makeEnvelope("audit.snapshot", null, {
      events: getAuditStore().recent(),
    }),
  );

  const forward = (envelope: ServerMessage | Envelope<unknown>): void => {
    sendEnvelope(socket, envelope as Envelope<unknown>);
  };

  sessionStore.on("event", forward);

  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    handleIncomingMessage(socket, raw);
  });

  socket.on("close", () => {
    sessionStore.off("event", forward);
  });

  socket.on("error", (err: Error) => {
    console.error("[orbitory-host-agent] WS socket error:", err);
  });
}

interface TokenResolution {
  token: string | undefined;
  /** True only when no valid `client.hello` arrived before `HELLO_TIMEOUT_MS` elapsed. */
  timedOut: boolean;
}

/**
 * Resolves the pairing token for a new connection.
 *
 * If a token was supplied on the query string, it is used immediately.
 * Otherwise this waits up to `HELLO_TIMEOUT_MS` for a `client.hello`
 * message carrying `payload.token`. If the timeout elapses with no valid
 * hello received at all, `timedOut` is `true`; if a hello did arrive but
 * had no (or a non-string) token, `timedOut` is `false` and `token` is
 * `undefined` — the caller treats both as auth failures, but reports a more
 * precise `error.code` for each (see handleConnection).
 */
function resolveToken(
  socket: WebSocket,
  queryToken: string | undefined,
): Promise<TokenResolution> {
  if (queryToken !== undefined) {
    return Promise.resolve({ token: queryToken, timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.off("message", onMessage);
      resolve({ token: undefined, timedOut: true });
    }, HELLO_TIMEOUT_MS);

    function onMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
      if (settled) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        // Not valid JSON; ignore and keep waiting for a proper hello
        // within the timeout window.
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { type?: unknown }).type !== "client.hello"
      ) {
        // Not a hello; ignore and keep waiting.
        return;
      }

      const payload = (parsed as { payload?: unknown }).payload;
      const token =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { token?: unknown }).token === "string"
          ? ((payload as { token: string }).token as string)
          : undefined;

      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve({ token, timedOut: false });
    }

    socket.on("message", onMessage);
  });
}

function handleIncomingMessage(
  socket: WebSocket,
  raw: Buffer | ArrayBuffer | Buffer[],
): void {
  try {
    const parsed: unknown = JSON.parse(raw.toString());

    if (typeof parsed !== "object" || parsed === null) {
      sendError(socket, null, "invalid_payload", "Message is not an object.");
      return;
    }

    const message = parsed as Partial<ClientMessage> & {
      type?: unknown;
      sessionId?: unknown;
      payload?: unknown;
    };

    const type = message.type;
    if (typeof type !== "string") {
      sendError(socket, null, "invalid_payload", "Missing message type.");
      return;
    }

    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : null;
    const payload = (message.payload ?? {}) as Record<string, unknown>;

    dispatch(socket, type, sessionId, payload);
  } catch (err) {
    console.error(
      "[orbitory-host-agent] Failed to parse incoming WS message:",
      err,
    );
    sendError(socket, null, "invalid_payload", "Malformed JSON message.");
  }
}

function dispatch(
  socket: WebSocket,
  type: string,
  sessionId: string | null,
  payload: Record<string, unknown>,
): void {
  try {
    switch (type) {
      case "chat.message": {
        if (!sessionId || typeof payload["text"] !== "string") {
          sendError(
            socket,
            sessionId,
            "invalid_payload",
            "chat.message requires sessionId and payload.text.",
          );
          return;
        }
        // `messageId` is the client-generated idempotency key from
        // docs/protocol.md §7's idempotency notes: resending the same id for
        // the same session (e.g. after a reconnect) is de-duplicated by
        // sessionStore instead of appending the message twice.
        const messageId =
          typeof payload["messageId"] === "string" ? payload["messageId"] : undefined;
        sessionStore.handleChatMessage(sessionId, payload["text"], messageId);
        return;
      }

      case "approval.decision": {
        const approvalId = payload["approvalId"];
        const decision = payload["decision"];
        const scope = payload["scope"];
        if (
          !sessionId ||
          typeof approvalId !== "string" ||
          (decision !== "approve" && decision !== "reject") ||
          (scope !== undefined && scope !== "once" && scope !== "always_this_session")
        ) {
          sendError(
            socket,
            sessionId,
            "invalid_payload",
            "approval.decision requires sessionId, payload.approvalId, a valid payload.decision, and a valid payload.scope.",
          );
          return;
        }
        // `scope` mirrors docs/protocol.md's client->server `approval.decision`
        // payload ("once" | "always_this_session"); translate it into the
        // boolean `allowSimilarForSession` that `sessionStore.handleApprovalDecision`
        // expects. Default to "once" (i.e. false) if omitted.
        const allowSimilarForSession = scope === "always_this_session";
        sessionStore.handleApprovalDecision(
          approvalId,
          decision as ApprovalDecision,
          allowSimilarForSession,
        );
        return;
      }

      case "session.stop": {
        const reason = payload["reason"];
        if (
          !sessionId ||
          (reason !== undefined &&
            reason !== "user_requested" &&
            reason !== "timeout" &&
            reason !== "error")
        ) {
          sendError(
            socket,
            sessionId,
            "invalid_payload",
            'session.stop requires sessionId, and payload.reason (if present) must be "user_requested", "timeout", or "error".',
          );
          return;
        }
        // `reason` is validated per docs/protocol.md §5 but not yet acted on
        // beyond that — every stop currently produces the same "Stopped by
        // user." outcome regardless of reason. Differentiated handling
        // (e.g. a distinct failure reason for "timeout") is future work.
        sessionStore.stopSession(sessionId);
        recordSessionStopRequested(sessionId);
        return;
      }

      case "session.start": {
        const hostId = payload["hostId"];
        const agentType = payload["agentType"];
        const title = payload["title"];
        if (
          typeof hostId !== "string" ||
          typeof agentType !== "string" ||
          typeof title !== "string"
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.start requires payload.hostId, payload.agentType, and payload.title.",
          );
          return;
        }
        // `providerId` is optional and, if present, is only ever used as a
        // lookup key against the host's own orbitory.config.json allowlist
        // (see sessionStore.startSession / agentConfig.ts) — it is never
        // treated as a command or forwarded to a shell.
        const providerId =
          typeof payload["providerId"] === "string" ? payload["providerId"] : undefined;
        // `initialPrompt` (docs/protocol.md §5) is delivered as the session's
        // first user chat message — for a terminal-backed session that means
        // the provider writes it to the child's stdin, exactly like any other
        // chat.message. It is data to the process, never a command.
        const initialPrompt =
          typeof payload["initialPrompt"] === "string" ? payload["initialPrompt"] : undefined;
        // Phase 10: audit a real provider start request (mock starts are covered
        // by the derived session.started event).
        if (providerId !== undefined) {
          recordProviderStartRequested(providerId, agentType);
        }
        const created = sessionStore.startSession(hostId, agentType, title, providerId, initialPrompt);
        if (created === undefined && providerId !== undefined) {
          // A provider-specific rejection (unknown/disabled id). Reason code only —
          // never the hostile client fields, command, args, image, or env.
          recordProviderStartRejected(providerId, "unknown_or_disabled");
        }
        return;
      }

      case "session.request_summary": {
        if (!sessionId) {
          sendError(
            socket,
            sessionId,
            "invalid_payload",
            "session.request_summary requires sessionId.",
          );
          return;
        }
        sessionStore.requestSummary(sessionId);
        return;
      }

      case "providers.request": {
        // Phase 6: re-send the sanitized provider list to just this socket
        // (e.g. iOS pull-to-refresh). No session scope, no side effects.
        sendEnvelope(
          socket,
          makeEnvelope("providers.snapshot", null, {
            providers: sessionStore.getProviderDescriptors(),
          }),
        );
        return;
      }

      case "audit.request": {
        // Phase 10: re-send the recent audit snapshot to just this socket.
        sendEnvelope(
          socket,
          makeEnvelope("audit.snapshot", null, {
            events: getAuditStore().recent(),
          }),
        );
        return;
      }

      case "client.hello": {
        // A second hello after the handshake window is a no-op; the
        // connection is already authenticated.
        return;
      }

      default: {
        sendError(
          socket,
          sessionId,
          "unknown_event_type",
          `Unknown message type "${type}".`,
        );
        return;
      }
    }
  } catch (err) {
    console.error(
      `[orbitory-host-agent] Error dispatching "${type}" message:`,
      err,
    );
    sendError(
      socket,
      sessionId,
      "internal_error",
      "Unexpected server error while handling message.",
    );
  }
}

export default registerWebSocketRoute;
