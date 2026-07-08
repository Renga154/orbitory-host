/**
 * Small WebSocket test helper: connect, collect/await envelopes by
 * predicate, and send JSON messages, without pulling in a new dependency
 * (uses the `ws` package that's already a runtime dependency of the
 * host-agent itself).
 */

import { WebSocket } from "ws";

import type { Envelope } from "../../src/types.js";

export interface TestWsClient {
  socket: WebSocket;
  /** All envelopes received so far, in order. */
  received: Envelope<unknown>[];
  /** Resolves once the socket's `open` event has fired. */
  waitForOpen(): Promise<void>;
  /** Resolves with the socket close code/reason once the socket closes. */
  waitForClose(): Promise<{ code: number; reason: string }>;
  /**
   * Waits for the next-received envelope matching `predicate`, starting
   * from envelopes not yet consumed by a previous call. Rejects if `timeoutMs`
   * elapses first (default 5000ms), or if the socket closes first.
   */
  waitFor(
    predicate: (envelope: Envelope<unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Envelope<unknown>>;
  send(message: unknown): void;
  sendRaw(raw: string): void;
  close(): void;
}

export function connect(url: string, options?: { rejectUnauthorized?: boolean }): TestWsClient {
  // `options` lets WSS tests pass `rejectUnauthorized: false` for the self-signed
  // fixture cert (real trust is done via fingerprint pinning on the iOS side).
  const socket = options ? new WebSocket(url, options) : new WebSocket(url);
  const received: Envelope<unknown>[] = [];
  let cursor = 0;
  let closedInfo: { code: number; reason: string } | undefined;
  const closeWaiters: Array<(info: { code: number; reason: string }) => void> = [];
  const openWaiters: Array<() => void> = [];
  let isOpen = false;

  socket.on("open", () => {
    isOpen = true;
    for (const w of openWaiters.splice(0)) w();
  });

  socket.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString()) as Envelope<unknown>;
      received.push(parsed);
    } catch {
      // Ignore non-JSON frames (shouldn't happen per protocol, but don't
      // crash the test harness if it does).
    }
  });

  socket.on("close", (code: number, reasonBuf: Buffer) => {
    closedInfo = { code, reason: reasonBuf.toString() };
    for (const w of closeWaiters.splice(0)) w(closedInfo);
  });

  return {
    socket,
    received,
    waitForOpen(): Promise<void> {
      if (isOpen) return Promise.resolve();
      return new Promise((resolve) => openWaiters.push(resolve));
    },
    waitForClose(): Promise<{ code: number; reason: string }> {
      if (closedInfo) return Promise.resolve(closedInfo);
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    waitFor(
      predicate: (envelope: Envelope<unknown>) => boolean,
      timeoutMs = 5000,
    ): Promise<Envelope<unknown>> {
      return new Promise((resolve, reject) => {
        // First check anything already buffered starting at cursor.
        for (let i = cursor; i < received.length; i++) {
          const env = received[i]!;
          if (predicate(env)) {
            cursor = i + 1;
            resolve(env);
            return;
          }
        }

        const timer = setTimeout(() => {
          socket.off("message", onMessage);
          socket.off("close", onClose);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for matching envelope. Received so far: ${JSON.stringify(
                received.map((e) => e.type),
              )}`,
            ),
          );
        }, timeoutMs);

        function onMessage(): void {
          for (let i = cursor; i < received.length; i++) {
            const env = received[i]!;
            if (predicate(env)) {
              cursor = i + 1;
              clearTimeout(timer);
              socket.off("message", onMessage);
              socket.off("close", onClose);
              resolve(env);
              return;
            }
          }
        }

        function onClose(): void {
          clearTimeout(timer);
          socket.off("message", onMessage);
          reject(
            new Error(
              `Socket closed before a matching envelope arrived. Received so far: ${JSON.stringify(
                received.map((e) => e.type),
              )}`,
            ),
          );
        }

        socket.on("message", onMessage);
        socket.on("close", onClose);
      });
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
    sendRaw(raw: string): void {
      socket.send(raw);
    },
    close(): void {
      try {
        socket.close();
      } catch {
        // ignore
      }
    },
  };
}
