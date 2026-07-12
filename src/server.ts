/**
 * Fastify application factory for the Orbitory host-agent.
 *
 * Builds (but does not start listening on) a single Fastify instance that
 * serves both the plain HTTP routes (`/health`, `/sessions`) and the
 * realtime `/ws` WebSocket route on one port. Starting the server (calling
 * `listen()`) is the responsibility of `index.ts`.
 */

import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { registerInternalApprovalRoute } from "./approvalBridge.js";
import { deriveAuditFromEnvelope, setAuditBroadcast } from "./audit.js";
import { NODE_ENV } from "./config.js";
import { registerHttpRoutes } from "./http.js";
import { redactingRequestSerializer } from "./logging.js";
import sessionStore from "./sessionStore.js";
import type { AuditEvent, Envelope } from "./types.js";
import { registerWebSocketRoute, type ProjectCatalogSnapshotSource } from "./ws.js";

/**
 * Phase 10 audit wiring. The derive listener maps the session/approval envelope
 * stream to audit events; the broadcast pushes each recorded event out as
 * `audit.event.created` through the same session hub `ws.ts` forwards from.
 * Registered idempotently (off-then-on) so repeated `buildServer()` calls in
 * tests don't accumulate duplicate listeners.
 */
function auditDeriveListener(envelope: Envelope<unknown>): void {
  // Never re-derive from our own audit envelopes (avoids any feedback loop).
  if (envelope.type === "audit.event.created" || envelope.type === "audit.snapshot") return;
  deriveAuditFromEnvelope(envelope);
}

function wireAudit(): void {
  sessionStore.off("event", auditDeriveListener);
  sessionStore.on("event", auditDeriveListener);
  setAuditBroadcast((event: AuditEvent) => {
    const envelope: Envelope<{ event: AuditEvent }> = {
      type: "audit.event.created",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: event.sessionId,
      payload: { event },
    };
    sessionStore.emit("event", envelope);
  });
}

export interface BuildServerOptions {
  /**
   * Optional custom destination for the Fastify/pino logger. Used by tests
   * to capture log output in-memory (see tests/helpers/testServer.ts and
   * tests/log-redaction.test.ts) instead of writing to stdout. When
   * omitted, pino writes to stdout as usual.
   */
  loggerStream?: { write(msg: string): void };
  /**
   * TLS material (Phase 9). When present, Fastify serves HTTPS (and, via
   * `@fastify/websocket`, WSS) instead of plaintext HTTP/WS. The private key is
   * used only to configure the server and is never logged.
   */
  tls?: { cert: Buffer; key: Buffer };
  /** Injectable read-only project catalog for deterministic transport tests. */
  projectCatalog?: ProjectCatalogSnapshotSource;
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.tls ? { https: { cert: options.tls.cert, key: options.tls.key } } : {}),
    logger: {
      level: NODE_ENV === "production" ? "info" : "debug",
      // Defense in depth: redact the Authorization header if anything ever
      // logs it directly (the request serializer below doesn't emit
      // headers at all, so this matters only for code paths outside our
      // control, e.g. a future plugin).
      redact: {
        paths: ["req.headers.authorization"],
        censor: "**redacted**",
      },
      serializers: {
        req: redactingRequestSerializer,
      },
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
    },
  });

  await app.register(fastifyWebsocket);

  wireAudit();
  await registerHttpRoutes(app);
  registerWebSocketRoute(app, options.projectCatalog);
  // Phase 16: loopback-only approval-bridge endpoint for the Claude Code
  // stream provider's permission-prompt tool (see src/approvalBridge.ts).
  // Guarded by a per-session bridge token — NOT part of the client protocol.
  registerInternalApprovalRoute(app);

  return app;
}

export default buildServer;
