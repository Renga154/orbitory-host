/**
 * Shared logging helpers for the Orbitory host-agent.
 *
 * Rule: the pairing token must never appear in full in ANY log line —
 * custom `console.log`/`console.warn` messages, Fastify's automatic
 * request/response logger, or captured test output. Only the last 4
 * characters may ever be shown, prefixed with "...".
 *
 * This module is the single place that rule is implemented, so every log
 * surface (src/ws.ts's custom connection logs, src/http.ts's REST auth
 * logs, and src/server.ts's Fastify request logger) shares one
 * implementation instead of each reinventing redaction slightly differently.
 */

/** Query parameter name that may carry the pairing token on REST/WS requests. */
const TOKEN_QUERY_PARAM = "token";

/**
 * Redacts a pairing token for logging: shows only the last 4 characters,
 * prefixed with "...". Never log the full token value.
 */
export function redactToken(token: string | undefined | null): string {
  if (!token) {
    return "(none)";
  }
  if (token.length <= 4) {
    return `...${token}`;
  }
  return `...${token.slice(-4)}`;
}

/**
 * Redacts a `token` query parameter from a request URL (path + query, as
 * Fastify's `request.url`/the raw Node request's `.url` provides it — no
 * scheme or host). No-op if the URL has no query string or no `token` param.
 *
 * Used as part of the Fastify request-log serializer (see server.ts) so the
 * automatic "incoming request" / "request completed" log lines never
 * include a raw pairing token, for both `GET /sessions?token=...` and the
 * `/ws?token=...` WebSocket upgrade request.
 */
export function redactUrl(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex === -1) {
    return rawUrl;
  }

  const pathname = rawUrl.slice(0, queryIndex);
  const queryString = rawUrl.slice(queryIndex + 1);

  const params = new URLSearchParams(queryString);
  const token = params.get(TOKEN_QUERY_PARAM);
  if (token === null) {
    return rawUrl;
  }

  params.set(TOKEN_QUERY_PARAM, redactToken(token));
  return `${pathname}?${params.toString()}`;
}

/**
 * Minimal shape this serializer needs from whatever request-like object
 * Fastify/pino passes in (loosely typed on purpose: pino serializers receive
 * the raw `http.IncomingMessage`-like object, not the `FastifyRequest`
 * wrapper, and its exact shape has varied across Fastify major versions).
 */
interface SerializableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string; remotePort?: number };
}

/**
 * Custom Fastify/pino `serializers.req` implementation: identical in spirit
 * to Fastify's default request serializer, except `url` has its `token`
 * query param redacted. Replaces (not supplements) the default serializer,
 * so no other code path can accidentally reintroduce a raw token into a
 * request log line via a field this serializer doesn't emit.
 */
export function redactingRequestSerializer(request: SerializableRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url ? redactUrl(request.url) : request.url,
    remoteAddress: request.socket?.remoteAddress,
    remotePort: request.socket?.remotePort,
  };
}
