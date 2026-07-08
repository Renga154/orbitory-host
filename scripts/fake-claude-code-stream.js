#!/usr/bin/env node
/**
 * Fake Claude Code **stream-json** CLI — the deterministic stand-in
 * `tests/claude-stream-provider.test.ts` drives instead of the real CLI
 * (which is NEVER run in anything automated; see
 * docs/PHASE16_REAL_AGENT_INTEGRATION.md §4.8).
 *
 * It emits the same stream-json event shapes the parser understands
 * (system/init → assistant text → tool_use Read/Edit/Bash `npm test` →
 * tool_result → result with usage/cost), reads stream-json user messages
 * from stdin and answers each with one assistant event echoing the text back
 * ("You said: …") so the chat round-trip is byte-assertable, then exits 0.
 *
 * Flags:
 *   --fail                 emit the spike-captured logged-out result error
 *                          (`is_error: true`, "Not logged in · Please run
 *                          /login") and exit 1
 *   --exit-code=N          crash mid-stream: exit N right after the tool
 *                          events, with NO result event (N != 0)
 *   --print-secrets        plant the SAME fabricated secrets as
 *                          scripts/fake-claude-code.js INSIDE event strings
 *                          (assistant text, Edit new_string, Bash command,
 *                          tool_result text) plus one raw stderr line — the
 *                          test asserts none of them reach any client sink
 *   --malformed-lines      interleave non-JSON garbage, a truncated JSON
 *                          line, and one huge raw line (must be forwarded as
 *                          plain scrubbed output, truncated, never a crash)
 *   --request-permission   POST a permission request to
 *                          $ORBITORY_APPROVAL_BRIDGE_URL with the bridge
 *                          token (exactly like scripts/orbitory-approval-
 *                          bridge.js would), then print an assistant event
 *                          reporting "permission-allowed" or
 *                          "permission-denied" based on the response
 *   --permission-on-sigterm
 *                          trap SIGTERM, POST one permission request, then
 *                          exit. This simulates a child that resists stop long
 *                          enough to prove Orbitory unregisters stale bridges.
 *   --linger-ms=N          how long to keep stdin open for chat after the
 *                          scripted sequence (default 400ms); receiving a
 *                          chat message answers it and exits 0 immediately
 *   --delay-ms=N           pacing between scripted events (default 40ms)
 *
 * Every "secret" is fabricated. Nothing here touches real files, spawns
 * processes, or reads real credentials.
 */

import readline from "node:readline";

function flagValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg ? Number(arg.split("=")[1]) : fallback;
}

const delayMs = flagValue("--delay-ms", 40);
const lingerMs = flagValue("--linger-ms", 400);
const crashExitCode = flagValue("--exit-code", 0);
const fail = process.argv.includes("--fail");
const printSecrets = process.argv.includes("--print-secrets");
const malformedLines = process.argv.includes("--malformed-lines");
const requestPermission = process.argv.includes("--request-permission");
const permissionOnSigterm = process.argv.includes("--permission-on-sigterm");
let handlingSigterm = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function assistantText(text) {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function toolUse(id, name, input) {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
}

function toolResult(id, text, isError = false) {
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }],
    },
  });
}

/** Mirrors what the real MCP bridge script does: POST + bearer token. */
async function postPermissionRequest() {
  const url = process.env.ORBITORY_APPROVAL_BRIDGE_URL;
  const token = process.env.ORBITORY_APPROVAL_BRIDGE_TOKEN;
  if (!url || !token) {
    assistantText("permission-denied: bridge env missing");
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        toolName: "Bash",
        input: { command: "rm -rf build" },
        toolUseId: "toolu_perm_1",
      }),
    });
    const outcome = await response.json();
    if (outcome.behavior === "allow") {
      assistantText("permission-allowed");
    } else {
      assistantText(`permission-denied: ${outcome.message ?? "(no message)"}`);
    }
  } catch (err) {
    assistantText(`permission-denied: ${err.message}`);
  }
}

if (permissionOnSigterm) {
  process.on("SIGTERM", () => {
    if (handlingSigterm) return;
    handlingSigterm = true;
    void (async () => {
      await postPermissionRequest();
      process.exit(0);
    })();
  });
}

/** Answer one stream-json user message with an echoing assistant event. */
function replyToUserLine(line) {
  let text = "";
  try {
    const parsed = JSON.parse(line);
    const content = parsed?.message?.content;
    if (Array.isArray(content)) {
      text = content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ");
    }
  } catch {
    return false;
  }
  if (text.length === 0) return false;
  assistantText(`You said: ${text}`);
  return true;
}

async function main() {
  emit({ type: "system", subtype: "init", session_id: "fake-stream-session-0001", model: "claude-fake-1" });
  await sleep(delayMs);

  if (requestPermission) {
    await postPermissionRequest();
    await sleep(delayMs);
  }

  assistantText(
    printSecrets
      ? "I found the config: ANTHROPIC_API_KEY=sk-ant-api03-fakeclaudefake1234 — fixing the bug now."
      : "I found the bug; fixing it now.",
  );
  await sleep(delayMs);

  toolUse("toolu_read_1", "Read", { file_path: "src/example.ts" });
  await sleep(delayMs);

  toolUse("toolu_edit_1", "Edit", {
    file_path: "src/example.ts",
    old_string: "const a = 1;",
    new_string: printSecrets
      ? "const a = 2; // ghp_fakeclaudefake1234567890abcdefgh"
      : "const a = 2;",
  });
  await sleep(delayMs);

  if (printSecrets) {
    // One raw stderr secret + one raw unparseable stdout secret line, mirroring
    // scripts/fake-claude-code.js so both raw-line scrub paths are covered.
    console.error("stderr note: OPENAI_KEY=sk-fakeclaudestderr1234567890");
    process.stdout.write("bare assignment TOKEN=fake-claude-bare-token-42\n");
    await sleep(delayMs);
  }

  if (malformedLines) {
    process.stdout.write("this is not json at all\n");
    process.stdout.write('{"type":"assistant","message":\n'); // truncated JSON
    process.stdout.write(`raw huge ${"x".repeat(6000)}\n`); // must be truncated downstream
    await sleep(delayMs);
  }

  toolUse("toolu_bash_1", "Bash", {
    command: printSecrets ? "TOKEN=fake-claude-bare-token-42 npm test" : "npm test",
  });
  await sleep(delayMs);

  toolResult(
    "toolu_bash_1",
    printSecrets
      ? "> vitest run\nloaded key sk-ant-api03-fakeclaudefake1234\nTests  7 passed | 0 failed\nDuration: in 1.2s"
      : "> vitest run\nTests  7 passed | 0 failed\nDuration: in 1.2s",
  );
  await sleep(delayMs);

  if (fail) {
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    process.exit(1);
  }

  if (crashExitCode !== 0) {
    // Crash mid-stream: no result event, just a non-zero exit.
    process.exit(crashExitCode);
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 250 },
  });

  // Linger for a possible chat message; answering one ends the run so the
  // round-trip is deterministic for tests.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const timer = setTimeout(() => process.exit(0), lingerMs);
  rl.on("line", (line) => {
    if (replyToUserLine(line)) {
      clearTimeout(timer);
      // Give the reply a moment to flush before exiting cleanly.
      setTimeout(() => process.exit(0), 50);
    }
  });
}

main();
