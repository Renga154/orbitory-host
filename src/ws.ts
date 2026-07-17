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
import { pairingTokensEqual, verifyPresentedToken } from "./auth.js";
import {
  getAuditStore,
  recordAuthFailed,
  recordProviderStartRejected,
  recordProviderStartRequested,
  recordSessionStopRequested,
} from "./audit.js";
import { redactToken } from "./logging.js";
import { projectCatalog, type ProjectCreationResult } from "./projectCatalog.js";
import { sessionStore } from "./sessionStore.js";
import type {
  ApprovalDecision,
  ClientMessage,
  Envelope,
  ErrorPayload,
  ProjectsSnapshotPayload,
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
  "projects",
  "sessionControlsV1",
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
  "idempotency_conflict",
]);

function recoverableForCode(code: string): boolean {
  return !NON_RECOVERABLE_ERROR_CODES.has(code);
}

function sendError(
  socket: WebSocket,
  sessionId: string | null,
  code: string,
  message: string,
  requestId?: string,
  recoverableOverride?: boolean,
): void {
  const payload: ErrorPayload = {
    code,
    message,
    recoverable: recoverableOverride ?? recoverableForCode(code),
    ...(requestId !== undefined ? { requestId } : {}),
  };
  sendEnvelope(socket, makeEnvelope("error", sessionId, payload));
}

function validatedRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value
    : undefined;
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
export interface ProjectCatalogSnapshotSource {
  snapshot(force?: boolean): Promise<ProjectsSnapshotPayload>;
  createProject?(
    requestId: string,
    name: string,
    providerId: string,
  ): Promise<ProjectCreationResult>;
}

export function registerWebSocketRoute(
  app: FastifyInstance,
  catalog: ProjectCatalogSnapshotSource = projectCatalog,
): void {
  app.get(
    "/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      handleConnection(socket, request, catalog).catch((err) => {
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
  catalog: ProjectCatalogSnapshotSource,
): Promise<void> {
  const queryToken = extractTokenFromQuery(request);

  const { token, clientId, timedOut, unsupportedVersion } = await resolveToken(socket, queryToken);

  if (unsupportedVersion) {
    sendError(socket, null, "unsupported_version", "Only protocol version 1 is supported.");
    socket.close(4400, "unsupported_version");
    return;
  }

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

  const auth = verifyPresentedToken(token, clientId);
  if (!auth.ok) {
    console.warn(
      `[orbitory-host-agent] WS auth failed (${auth.reason}) for token ${redactToken(
        token,
      )}; closing connection.`,
    );
    // Phase 10: audit the auth failure (reason code only — never the token).
    recordAuthFailed(`ws:${auth.reason}`);
    const errorCode =
      auth.reason === "expired"
        ? "credential_expired"
        : auth.reason === "revoked"
          ? "credential_revoked"
          : auth.reason === "device_mismatch"
            ? "credential_device_mismatch"
            : "unauthorized";
    sendError(
      socket,
      null,
      errorCode,
      "Invalid or missing pairing token.",
    );
    socket.close(CLOSE_CODE_UNAUTHORIZED, "unauthorized");
    return;
  }

  // `verifyPresentedToken` cannot succeed without a concrete credential, but
  // keep the transport boundary fail-closed if that invariant ever changes.
  if (typeof token !== "string" || token.length === 0) {
    recordAuthFailed("ws:verified_without_token");
    sendError(socket, null, "unauthorized", "Invalid or missing pairing token.");
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
    makeEnvelope("providers.snapshot", null, sessionStore.getProviderCatalog()),
  );

  // Register the steady-state handlers before project history discovery. The
  // latter can take several seconds; client commands sent after server.hello
  // must never disappear while that read-only catalog is loading.
  const forward = (envelope: ServerMessage | Envelope<unknown>): void => {
    sendEnvelope(socket, envelope as Envelope<unknown>);
  };

  sessionStore.on("event", forward);

  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    handleIncomingMessage(socket, raw, catalog, token);
  });

  socket.on("close", () => {
    sessionStore.off("event", forward);
  });

  socket.on("error", (err: Error) => {
    console.error("[orbitory-host-agent] WS socket error:", err);
  });

  // Phase 10: recent audit events are available immediately and do not wait
  // for project history discovery.
  sendEnvelope(
    socket,
    makeEnvelope("audit.snapshot", null, {
      events: getAuditStore().recent(),
    }),
  );

  sendEnvelope(
    socket,
    makeEnvelope("projects.snapshot", null, await catalog.snapshot()),
  );
}

interface TokenResolution {
  token: string | undefined;
  clientId: string | undefined;
  /** True only when no valid `client.hello` arrived before `HELLO_TIMEOUT_MS` elapsed. */
  timedOut: boolean;
  unsupportedVersion: boolean;
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
    return Promise.resolve({
      token: queryToken,
      clientId: undefined,
      timedOut: false,
      unsupportedVersion: false,
    });
  }

  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.off("message", onMessage);
      resolve({
        token: undefined,
        clientId: undefined,
        timedOut: true,
        unsupportedVersion: false,
      });
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
      const rawClientId =
        typeof payload === "object" && payload !== null
          ? (payload as { clientId?: unknown }).clientId
          : undefined;
      const clientId =
        typeof rawClientId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(rawClientId)
          ? rawClientId
          : undefined;

      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      const version = (parsed as { version?: unknown }).version;
      resolve({
        token:
          version === 1 && !(rawClientId !== undefined && clientId === undefined)
            ? token
            : undefined,
        clientId,
        timedOut: false,
        unsupportedVersion: version !== 1,
      });
    }

    socket.on("message", onMessage);
  });
}

function handleIncomingMessage(
  socket: WebSocket,
  raw: Buffer | ArrayBuffer | Buffer[],
  catalog: ProjectCatalogSnapshotSource,
  authenticatedToken: string,
): void {
  try {
    const parsed: unknown = JSON.parse(raw.toString());

    if (typeof parsed !== "object" || parsed === null) {
      sendError(socket, null, "invalid_payload", "Message is not an object.");
      return;
    }

    const message = parsed as Partial<ClientMessage> & {
      type?: unknown;
      version?: unknown;
      sessionId?: unknown;
      payload?: unknown;
    };

    if (message.version !== 1) {
      sendError(socket, null, "unsupported_version", "Only protocol version 1 is supported.");
      return;
    }

    const type = message.type;
    if (typeof type !== "string") {
      sendError(socket, null, "invalid_payload", "Missing message type.");
      return;
    }

    if (
      message.sessionId !== undefined &&
      message.sessionId !== null &&
      typeof message.sessionId !== "string"
    ) {
      sendError(socket, null, "invalid_payload", "sessionId must be a string or null.");
      return;
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
    const rawPayload = message.payload ?? {};
    if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
      sendError(socket, sessionId, "invalid_payload", "payload must be an object.");
      return;
    }
    const payload = rawPayload as Record<string, unknown>;

    dispatch(socket, type, sessionId, payload, catalog, authenticatedToken);
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
  catalog: ProjectCatalogSnapshotSource,
  authenticatedToken: string,
): void {
  const correlatableRequestId = validatedRequestId(payload["requestId"]);
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
          typeof title !== "string" ||
          title.trim().length === 0 ||
          title.length > 240 ||
          payload["catalogRevision"] !== undefined ||
          payload["permissionProfileId"] !== undefined ||
          payload["toolsetId"] !== undefined
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.start is the legacy path and cannot carry access controls; use session.launch.",
            correlatableRequestId,
          );
          return;
        }
        // `providerId` is optional and, if present, is only ever used as a
        // lookup key against the host's own orbitory.config.json allowlist
        // (see sessionStore.startSession / agentConfig.ts) — it is never
        // treated as a command or forwarded to a shell.
        const rawProviderId = payload["providerId"];
        const rawProjectId = payload["projectId"];
        const rawResumeId = payload["resumeId"];
        const providerId = typeof rawProviderId === "string" ? rawProviderId : undefined;
        const projectId = typeof rawProjectId === "string" ? rawProjectId : undefined;
        const resumeId = typeof rawResumeId === "string" ? rawResumeId : undefined;
        const rawLaunchProfileId = payload["launchProfileId"];
        const rawModelId = payload["modelId"];
        const launchProfileId =
          typeof rawLaunchProfileId === "string" ? rawLaunchProfileId : undefined;
        const modelId = typeof rawModelId === "string" ? rawModelId : undefined;
        if (
          (rawProviderId !== undefined &&
            (providerId === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(providerId))) ||
          (rawProjectId !== undefined &&
            (projectId === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(projectId))) ||
          (rawResumeId !== undefined &&
            (resumeId === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(resumeId))) ||
          (rawLaunchProfileId !== undefined &&
            (launchProfileId === undefined ||
              !/^[A-Za-z0-9._-]{1,64}$/u.test(launchProfileId))) ||
          (rawModelId !== undefined &&
            (modelId === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(modelId)))
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.start provider/project/resume/control fields must be valid opaque ids.",
            correlatableRequestId,
          );
          return;
        }
        const rawRequestId = payload["requestId"];
        const requestId = typeof rawRequestId === "string" ? rawRequestId : undefined;
        if (
          rawRequestId !== undefined &&
          (requestId === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(requestId))
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.start payload.requestId must be 1-128 ASCII letters, numbers, '.', '_', or '-'.",
          );
          return;
        }
        // `initialPrompt` (docs/protocol.md §5) is delivered as the session's
        // first user chat message — for a terminal-backed session that means
        // the provider writes it to the child's stdin, exactly like any other
        // chat.message. It is data to the process, never a command.
        const rawInitialPrompt = payload["initialPrompt"];
        const initialPrompt =
          typeof rawInitialPrompt === "string" ? rawInitialPrompt : undefined;
        if (
          rawInitialPrompt !== undefined &&
          (initialPrompt === undefined || initialPrompt.length > 65_536)
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.start initialPrompt must be a string no longer than 65536 characters.",
            correlatableRequestId,
          );
          return;
        }
        // Phase 10: audit a real provider start request (mock starts are covered
        // by the derived session.started event).
        const result = sessionStore.startSession({
          hostId,
          agentType,
          title,
          providerId,
          initialPrompt,
          projectId,
          resumeId,
          requestId,
          launchProfileId,
          modelId,
        });
        if (
          providerId !== undefined &&
          (result.kind === "created" || (result.kind === "rejected" && result.freshAttempt))
        ) {
          recordProviderStartRequested(providerId, agentType);
        }
        if (result.kind === "rejected") {
          if (providerId !== undefined && result.providerStartRejectedReason !== undefined) {
            // Reason code only — never the hostile client fields, command, args, image, or env.
            recordProviderStartRejected(providerId, result.providerStartRejectedReason);
          }
          sendError(
            socket,
            result.sessionId,
            result.code,
            result.message,
            result.requestId,
            result.recoverable,
          );
          return;
        }
        if (result.kind === "replayed") {
          sendEnvelope(socket, sessionStore.makeSessionCreatedMessage(result.session));
        }
        return;
      }

      case "session.launch": {
        const allowedKeys = new Set([
          "catalogRevision",
          "hostId",
          "agentType",
          "title",
          "requestId",
          "providerId",
          "projectId",
          "resumeId",
          "launchProfileId",
          "modelId",
          "permissionProfileId",
          "toolsetId",
          "initialPrompt",
        ]);
        if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.launch contains an unsupported field.",
            correlatableRequestId,
          );
          return;
        }

        const catalogRevision = payload["catalogRevision"];
        const hostId = payload["hostId"];
        const agentType = payload["agentType"];
        const title = payload["title"];
        const providerId = payload["providerId"];
        const launchProfileId = payload["launchProfileId"];
        const modelId = payload["modelId"];
        const permissionProfileId = payload["permissionProfileId"];
        const toolsetId = payload["toolsetId"];
        const safeControlId = (value: unknown): value is string =>
          typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
        if (
          typeof catalogRevision !== "string" ||
          !/^pcat_[a-f0-9]{16}$/u.test(catalogRevision) ||
          typeof hostId !== "string" ||
          typeof agentType !== "string" ||
          typeof title !== "string" ||
          title.trim().length === 0 ||
          title.length > 240 ||
          !safeControlId(providerId) ||
          !safeControlId(launchProfileId) ||
          !safeControlId(modelId) ||
          !safeControlId(permissionProfileId) ||
          !safeControlId(toolsetId)
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.launch requires a current catalog revision and valid provider control ids.",
            correlatableRequestId,
          );
          return;
        }

        const projectId = payload["projectId"];
        const resumeId = payload["resumeId"];
        const requestId = payload["requestId"];
        const initialPrompt = payload["initialPrompt"];
        if (
          (projectId !== undefined &&
            (typeof projectId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(projectId))) ||
          (resumeId !== undefined &&
            (typeof resumeId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(resumeId))) ||
          (requestId !== undefined &&
            (typeof requestId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(requestId))) ||
          (initialPrompt !== undefined &&
            (typeof initialPrompt !== "string" || initialPrompt.length > 65_536))
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "session.launch optional fields are malformed.",
            correlatableRequestId,
          );
          return;
        }

        const result = sessionStore.startSession({
          catalogRevision,
          strictControls: true,
          hostId,
          agentType,
          title,
          providerId,
          launchProfileId,
          modelId,
          permissionProfileId,
          toolsetId,
          ...(typeof projectId === "string" ? { projectId } : {}),
          ...(typeof resumeId === "string" ? { resumeId } : {}),
          ...(typeof requestId === "string" ? { requestId } : {}),
          ...(typeof initialPrompt === "string" ? { initialPrompt } : {}),
        });
        if (result.kind === "created" || (result.kind === "rejected" && result.freshAttempt)) {
          recordProviderStartRequested(providerId, agentType);
        }
        if (result.kind === "rejected") {
          if (result.providerStartRejectedReason !== undefined) {
            recordProviderStartRejected(providerId, result.providerStartRejectedReason);
          }
          sendError(
            socket,
            result.sessionId,
            result.code,
            result.message,
            result.requestId,
            result.recoverable,
          );
          return;
        }
        if (result.kind === "replayed") {
          sendEnvelope(socket, sessionStore.makeSessionCreatedMessage(result.session));
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
          makeEnvelope("providers.snapshot", null, sessionStore.getProviderCatalog()),
        );
        return;
      }

      case "projects.request": {
        void catalog
          .snapshot(true)
          .then((snapshot) => {
            sendEnvelope(socket, makeEnvelope("projects.snapshot", null, snapshot));
          })
          .catch(() => {
            sendError(
              socket,
              null,
              "internal_error",
              "Unable to refresh the project catalog.",
            );
          });
        return;
      }

      case "project.create": {
        const requestId = payload["requestId"];
        const name = payload["name"];
        const providerId = payload["providerId"];
        const allowedKeys = new Set(["requestId", "name", "providerId"]);
        if (
          typeof requestId !== "string" ||
          !/^[A-Za-z0-9._-]{1,128}$/u.test(requestId) ||
          typeof name !== "string" ||
          typeof providerId !== "string" ||
          Object.keys(payload).some((key) => !allowedKeys.has(key))
        ) {
          sendError(
            socket,
            null,
            "invalid_payload",
            "project.create requires only payload.requestId, payload.name, and payload.providerId.",
            correlatableRequestId,
          );
          return;
        }
        if (!catalog.createProject) {
          sendError(
            socket,
            null,
            "project_creation_disabled",
            "Project creation is unavailable.",
            correlatableRequestId,
          );
          return;
        }
        void catalog
          .createProject(requestId, name, providerId)
          .then((result) => {
            if (!result.ok) {
              sendError(socket, null, result.code, result.message, requestId);
              return;
            }
            sendEnvelope(
              socket,
              makeEnvelope("project.created", null, {
                requestId,
                project: result.project,
              }),
            );
            sendEnvelope(socket, makeEnvelope("projects.snapshot", null, result.snapshot));
          })
          .catch(() => {
            sendError(
              socket,
              null,
              "project_creation_failed",
              "Unable to create the project.",
              requestId,
            );
          });
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
        const repeatedToken = payload["token"];
        if (repeatedToken === undefined) {
          return;
        }
        if (
          typeof repeatedToken !== "string" ||
          !pairingTokensEqual(repeatedToken, authenticatedToken)
        ) {
          recordAuthFailed("ws:hello_token_mismatch");
          sendError(
            socket,
            null,
            "unauthorized",
            "A repeated client.hello token did not match the authenticated credential.",
          );
          socket.close(CLOSE_CODE_UNAUTHORIZED, "unauthorized");
          return;
        }
        // A repeated hello is otherwise a no-op. It cannot replace the
        // credential that authenticated this connection.
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
      correlatableRequestId,
      false,
    );
  }
}

export default registerWebSocketRoute;
