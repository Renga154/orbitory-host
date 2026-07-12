#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

const catalogHome = process.env.CODEX_HOME;
let scenario = {};
if (catalogHome) {
  try {
    scenario = JSON.parse(
      fs.readFileSync(path.join(catalogHome, "sessions", "orbitory-test-scenario.json"), "utf8"),
    );
    // The catalog home must be disposable and writable, while host credentials
    // and config must remain outside it.
    fs.writeFileSync(path.join(catalogHome, "catalog-write-probe"), "ok");
    if (fs.existsSync(path.join(catalogHome, "auth.json"))) process.exit(3);
    if (fs.existsSync(path.join(catalogHome, "config.toml"))) process.exit(4);
  } catch {
    scenario = {};
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 1 && message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      userAgent: "fake-codex",
      platformFamily: "unix",
      platformOs: "macos",
      codexHome: "/not-exposed",
    } })}\n`);
    return;
  }
  if (message.id === 2 && message.method === "thread/list") {
    const cwd = typeof scenario.cwd === "string" ? scenario.cwd : undefined;
    const secondCwd = typeof scenario.secondCwd === "string" ? scenario.secondCwd : undefined;
    const data = cwd ? [
      {
        id: "thread-secret-001",
        sessionId: "session-secret-001",
        cwd,
        name: "Fix login flow",
        preview: "secret preview must not cross the Orbitory wire",
        updatedAt: 1_783_800_000,
        createdAt: 1_783_700_000,
        cliVersion: "0.139.0",
        ephemeral: false,
        modelProvider: "openai",
        source: "vscode",
        status: { type: "idle" },
        turns: [],
        parentThreadId: null,
      },
      ...(secondCwd ? [{
        id: "thread-secret-002",
        sessionId: "session-secret-002",
        cwd: secondCwd,
        name: null,
        preview: "another private prompt",
        updatedAt: 1_783_700_000,
        createdAt: 1_783_600_000,
        cliVersion: "0.139.0",
        ephemeral: false,
        modelProvider: "openai",
        source: "vscode",
        status: { type: "idle" },
        turns: [],
        parentThreadId: null,
      }] : []),
      {
        id: "subagent-secret",
        sessionId: "subagent-session-secret",
        cwd,
        name: "Subagent must be skipped",
        preview: "private",
        updatedAt: 1_783_750_000,
        createdAt: 1_783_740_000,
        cliVersion: "0.139.0",
        ephemeral: false,
        modelProvider: "openai",
        source: "appServer",
        status: { type: "idle" },
        turns: [],
        parentThreadId: "thread-secret-001",
      },
    ] : [];
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {
      data,
      nextCursor: null,
      backwardsCursor: null,
    } })}\n`, () => {
      if (scenario.exitAfterList === true) process.exit(0);
    });
  }
});
