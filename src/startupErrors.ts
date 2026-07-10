interface SystemErrorLike extends Error {
  code?: string;
}

/** Convert common startup failures into concise operator guidance. */
export function formatStartupError(error: unknown, port: number): string {
  if (isSystemError(error) && error.code === "EADDRINUSE") {
    return [
      `[orbitory-host-agent] Port ${port} is already in use.`,
      "If an Orbitory host is already running, keep it running and tap Refresh in Orbitory; provider config changes reload automatically.",
      `If another app owns the port, stop it or start Orbitory on another port, for example: PORT=${port + 1} npx orbitory-host@latest`,
    ].join("\n");
  }

  return `[orbitory-host-agent] Fatal error during startup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
}

function isSystemError(error: unknown): error is SystemErrorLike {
  return error instanceof Error && "code" in error;
}
