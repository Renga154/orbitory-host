#!/usr/bin/env node
/**
 * Orbitory approval bridge — a minimal MCP stdio server that Claude Code
 * spawns (via the generated `--mcp-config`) so its `--permission-prompt-tool
 * mcp__orbitory__approval_prompt` calls reach the Orbitory host-agent.
 *
 * Plain Node, zero dependencies, newline-delimited JSON-RPC 2.0 over
 * stdin/stdout (the MCP stdio transport). It exposes exactly ONE tool,
 * `approval_prompt`; each `tools/call` is forwarded as an HTTP POST to the
 * host-agent's loopback-only `/internal/approvals` endpoint:
 *
 *   POST  ${ORBITORY_APPROVAL_BRIDGE_URL}
 *   Authorization: Bearer ${ORBITORY_APPROVAL_BRIDGE_TOKEN}
 *   { "toolName": ..., "input": {...}, "toolUseId": ... }
 *
 * and the endpoint's `{ behavior, message?, updatedInput? }` response is
 * returned to Claude Code as the tool result (JSON text content, per the
 * permission-prompt-tool contract).
 *
 * FAIL CLOSED: on ANY error — missing env, unreachable endpoint, non-2xx,
 * unparseable response — the tool returns `{"behavior":"deny",...}`. A broken
 * bridge must never let an action through.
 *
 * The bridge token is a per-session random value injected by
 * `ClaudeCodeStreamProvider`; it is NOT the pairing token (which is stripped
 * from the child environment) and is never printed by this script.
 */

// ESM (host-agent/package.json sets "type": "module"), plain Node built-ins only.
import readline from "node:readline";

const SERVER_INFO = { name: "orbitory-approval-bridge", version: "1.0.0" };
const TOOL_NAME = "approval_prompt";

/** Write one JSON-RPC message as a single stdout line. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A deny outcome in the exact shape Claude Code's permission contract expects. */
function denyContent(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message }) }],
  };
}

/** Forward one permission request to the host-agent; deny on any failure. */
async function forwardToHostAgent(args) {
  const url = process.env.ORBITORY_APPROVAL_BRIDGE_URL;
  const token = process.env.ORBITORY_APPROVAL_BRIDGE_TOKEN;
  if (!url || !token) {
    return denyContent("Orbitory approval bridge is not configured; denying (fail closed).");
  }

  const toolName = typeof args.tool_name === "string" ? args.tool_name : args.toolName;
  const input =
    typeof args.input === "object" && args.input !== null && !Array.isArray(args.input)
      ? args.input
      : {};
  const toolUseId = typeof args.tool_use_id === "string" ? args.tool_use_id : args.toolUseId;

  if (typeof toolName !== "string" || toolName.length === 0) {
    return denyContent("Malformed permission request (no tool name); denying (fail closed).");
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        toolName,
        input,
        ...(typeof toolUseId === "string" ? { toolUseId } : {}),
      }),
    });
  } catch {
    return denyContent("Orbitory approval bridge unreachable; denying (fail closed).");
  }

  if (!response.ok) {
    return denyContent(`Orbitory approval bridge rejected the request (HTTP ${response.status}); denying.`);
  }

  let outcome;
  try {
    outcome = await response.json();
  } catch {
    return denyContent("Orbitory approval bridge returned an unreadable response; denying (fail closed).");
  }

  if (!outcome || (outcome.behavior !== "allow" && outcome.behavior !== "deny")) {
    return denyContent("Orbitory approval bridge returned an invalid decision; denying (fail closed).");
  }

  return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    // Not JSON-RPC; ignore (never crash the bridge — a crash denies nothing
    // and just breaks the whole session).
    return;
  }
  if (typeof message !== "object" || message === null) return;

  const { id, method, params } = message;

  // Notifications (no id) require no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize": {
      // Mirror the client's protocolVersion (the handshake proven in the
      // Phase 16 spike); fall back to a known-good version string.
      const protocolVersion =
        params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    case "ping":
      sendResult(id, {});
      return;

    case "tools/list":
      sendResult(id, {
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Forwards a Claude Code permission request to the Orbitory host-agent so the user " +
              "can approve or reject it from the Orbitory iOS app. Denies on timeout or any error.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Name of the tool requesting permission." },
                input: { type: "object", description: "The tool's input." },
                tool_use_id: { type: "string", description: "The tool use id, when available." },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      });
      return;

    case "tools/call": {
      const name = params && typeof params.name === "string" ? params.name : "";
      if (name !== TOOL_NAME) {
        sendError(id, -32602, `Unknown tool "${name}".`);
        return;
      }
      const args = params && typeof params.arguments === "object" && params.arguments !== null
        ? params.arguments
        : {};
      try {
        sendResult(id, await forwardToHostAgent(args));
      } catch {
        sendResult(id, denyContent("Orbitory approval bridge internal error; denying (fail closed)."));
      }
      return;
    }

    default:
      sendError(id, -32601, `Method "${method}" not found.`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  void handleMessage(line);
});
rl.on("close", () => {
  process.exit(0);
});
