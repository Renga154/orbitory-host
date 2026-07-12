/**
 * HTTP routes for the Orbitory host-agent.
 *
 * Exposes a liveness/readiness check (`GET /health`, unauthenticated by
 * design — it's a liveness probe) and a one-shot REST snapshot of all known
 * sessions (`GET /sessions`, which per docs/protocol.md section 1 requires
 * the same pairing token as the WebSocket transport).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getAuditStore, recordAuthFailed } from "./audit.js";
import { verifyPresentedToken } from "./auth.js";
import { redactToken } from "./logging.js";
import { projectCatalog } from "./projectCatalog.js";
import { sessionStore } from "./sessionStore.js";
import type {
  AgentSession,
  AuditEvent,
  ProjectsSnapshotPayload,
  ProviderDescriptor,
} from "./types.js";

const processStartedAtMs = Date.now();

interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
  sessionCount: number;
}

interface SessionsResponse {
  sessions: AgentSession[];
}

interface ProvidersResponse {
  providers: ProviderDescriptor[];
}

type ProjectsResponse = ProjectsSnapshotPayload;

interface AuditResponse {
  events: AuditEvent[];
}

interface UnauthorizedResponse {
  error: "unauthorized";
}

/**
 * Extracts the pairing token from a REST request: either the
 * `Authorization: Bearer <token>` header, or a `?token=` query param, per
 * docs/protocol.md section 1 ("Requires the same pairing token as the
 * WebSocket, passed as a bearer token or query param"). If both are
 * present, the header takes precedence.
 */
function extractRestToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match?.[1]) {
      return match[1];
    }
  }

  const query = request.query as Record<string, unknown> | undefined;
  const queryToken = query?.["token"];
  if (typeof queryToken === "string" && queryToken.length > 0) {
    return queryToken;
  }

  return undefined;
}

/**
 * Saved device credentials are bound to the same opaque profile id used by
 * `client.hello`. REST clients present it separately so the credential cannot
 * be replayed from a different saved profile.
 */
function extractRestClientId(request: FastifyRequest): string | undefined {
  const value = request.headers["x-orbitory-client-id"];
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : undefined;
}

/**
 * Fastify `preHandler` that enforces pairing-token auth for REST routes
 * that require it (`GET /sessions`, `GET /providers`, and `GET /audit`).
 * Never logs the full token value — only the redacted last-4-characters
 * form, matching the convention used for the WebSocket transport in `ws.ts`.
 */
function requirePairingToken(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const token = extractRestToken(request);

  const auth = verifyPresentedToken(token, extractRestClientId(request));
  if (!auth.ok) {
    request.log.warn(
      `[orbitory-host-agent] REST auth failed (${auth.reason}) for token ${redactToken(token)}; rejecting request.`,
    );
    // Phase 10: audit the auth failure (reason code only — never the token).
    recordAuthFailed(`rest:${auth.reason}`);
    const body: UnauthorizedResponse = { error: "unauthorized" };
    reply.code(401).send(body);
    return;
  }

  done();
}

/**
 * Registers the host-agent's plain HTTP routes on the given Fastify
 * instance. Safe to call multiple times on different instances (e.g. in
 * tests), since it holds no module-level route-registration state beyond
 * the shared process start time used for uptime reporting.
 */
export async function registerHttpRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/health", async (): Promise<HealthResponse> => {
    const sessions = sessionStore.getSessionsSnapshot();
    return {
      status: "ok",
      uptimeSeconds: (Date.now() - processStartedAtMs) / 1000,
      sessionCount: sessions.length,
    };
  });

  app.get(
    "/sessions",
    { preHandler: requirePairingToken },
    async (): Promise<SessionsResponse> => {
      return {
        sessions: sessionStore.getSessionsSnapshot(),
      };
    },
  );

  // Phase 6: sanitized, read-only provider list. Same pairing-token auth as
  // /sessions; returns only display/control metadata — never command/args/env/
  // image/workingDirectory/paths (see docs/security.md §5).
  app.get(
    "/providers",
    { preHandler: requirePairingToken },
    async (): Promise<ProvidersResponse> => {
      return {
        providers: sessionStore.getProviderDescriptors(),
      };
    },
  );

  app.get(
    "/projects",
    { preHandler: requirePairingToken },
    async (): Promise<ProjectsResponse> => projectCatalog.snapshot(true),
  );

  // Phase 10: sanitized audit log. Same pairing-token auth as /sessions.
  // Optional query filters: limit, sessionId, providerId, since (ISO). Invalid
  // params are ignored safely. Returns only host-authored safe metadata — never
  // tokens, keys, env values, provider config, command/args, or raw output.
  app.get(
    "/audit",
    { preHandler: requirePairingToken },
    async (request: FastifyRequest): Promise<AuditResponse> => {
      const q = request.query as Record<string, unknown>;
      const asString = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      const limitRaw = asString(q["limit"]);
      const limit = limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
      return {
        events: getAuditStore().list({
          limit,
          sessionId: asString(q["sessionId"]),
          providerId: asString(q["providerId"]),
          since: asString(q["since"]),
        }),
      };
    },
  );
}

export default registerHttpRoutes;
