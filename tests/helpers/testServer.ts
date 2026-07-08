/**
 * Shared test helper for spinning up an isolated, real host-agent server
 * instance on an ephemeral port.
 *
 * Each test file that needs a running server should call `startTestServer()`
 * once (typically in a top-level `before()`), and `close()` it in `after()`.
 * Since `sessionStore` is a module-level singleton (see
 * `src/sessionStore.ts`), all server instances within a single test *process*
 * share the same session/host state — this is a known test-isolation
 * limitation (see the note in `tests/README` below and in the individual
 * test files). Each test *file* run via `node --test` gets its own module
 * registry/process-level state courtesy of Node's test runner isolating
 * each file, so seeded session counts are consistent within a file but
 * should not be assumed to start at a fixed count across the whole suite.
 */

import type { FastifyInstance } from "fastify";

import { setInternalApprovalBaseUrl } from "../../src/approvalBridge.js";
import { buildServer } from "../../src/server.js";

export interface TestServer {
  app: FastifyInstance;
  /** Base HTTP URL, e.g. "http://127.0.0.1:54321". */
  httpUrl: string;
  /** Base WebSocket URL, e.g. "ws://127.0.0.1:54321". */
  wsUrl: string;
  port: number;
  /**
   * Every raw log line the server's Fastify/pino logger wrote, in order —
   * only populated when `startTestServer({ captureLogs: true })` is used
   * (see tests/log-redaction.test.ts). `undefined` otherwise, so tests that
   * don't need this don't pay for an ever-growing array.
   */
  logLines?: string[];
  close(): Promise<void>;
}

export interface StartTestServerOptions {
  /**
   * When true, redirects the server's Fastify/pino logger into an in-memory
   * array (`logLines`) instead of stdout, so a test can assert on exactly
   * what was logged (e.g. that a pairing token never appears in full).
   */
  captureLogs?: boolean;
}

/**
 * Builds and starts a real Fastify instance (HTTP + `/ws`) bound to an
 * ephemeral, OS-assigned free port on the loopback interface, so tests never
 * collide with a dev server on a fixed port and can run concurrently.
 */
export async function startTestServer(
  options: StartTestServerOptions = {},
): Promise<TestServer> {
  const logLines: string[] | undefined = options.captureLogs ? [] : undefined;

  const app = await buildServer(
    logLines
      ? { loggerStream: { write: (msg: string) => logLines.push(msg) } }
      : {},
  );
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected server to bind to a network address with a port.");
  }
  const { port } = address;

  // Phase 16: point the approval bridge at this instance's real bound port so
  // stream-provider tests can complete permission round-trips.
  setInternalApprovalBaseUrl(`http://127.0.0.1:${port}`);

  return {
    app,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    logLines,
    async close(): Promise<void> {
      await app.close();
    },
  };
}
