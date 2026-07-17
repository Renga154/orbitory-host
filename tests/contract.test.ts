/**
 * Contract tests: cross-check every fixture in /shared/fixtures against
 * (a) the generic envelope shape, (b) the TypeScript payload interface
 * declared for that `type` in src/types.ts, and (c) for a subset of
 * high-value event types, the *actually emitted* runtime envelope from a
 * live mock-lifecycle run.
 *
 * This is the automated regression guard for cross-agent protocol drift:
 * a manual cross-check previously found
 * that host-agent's real emitted JSON had drifted from docs/protocol.md in
 * ~12 event types. This file exists so that kind of drift fails `npm test`
 * automatically instead of requiring another manual audit.
 *
 * IMPORTANT MAINTENANCE NOTE: TypeScript interfaces don't exist at runtime,
 * so `EXPECTED_PAYLOAD_KEYS` below is a hand-maintained mirror of every
 * payload interface in src/types.ts, keyed by envelope `type`. If a payload
 * interface in src/types.ts gains, loses, or renames a field, this map must
 * be updated by hand in the same change — nothing enforces that
 * automatically today. (A future improvement would be to introduce zod
 * schemas as the single source of truth for both runtime validation and
 * this test, eliminating the hand-sync requirement.)
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import type { Envelope, HostInfo, AgentSession } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_MIRROR_FIXTURES_DIR = path.resolve(__dirname, "../shared/fixtures");
const PRIVATE_REPO_FIXTURES_DIR = path.resolve(__dirname, "../../shared/fixtures");
const FIXTURES_DIR = fs.existsSync(PUBLIC_MIRROR_FIXTURES_DIR)
  ? PUBLIC_MIRROR_FIXTURES_DIR
  : PRIVATE_REPO_FIXTURES_DIR;

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

// ---------------------------------------------------------------------------
// Expected key sets per envelope `type`, mirrored by hand from src/types.ts.
// ---------------------------------------------------------------------------

/**
 * Fields marked optional (`?`) in the corresponding TypeScript interface.
 * A conforming payload's key set must be a subset of `required ∪ optional`
 * and a superset of `required` — i.e. every key present must be a known
 * field, and every required field must be present. This is the correct
 * notion of "exactly matches the interface" for interfaces that have
 * optional fields (e.g. `SessionUpdatedPayload`, whose fields are all
 * optional partial-patch fields by design).
 */
interface KeySpec {
  required: string[];
  optional?: string[];
}

const EXPECTED_PAYLOAD_KEYS: Record<string, KeySpec> = {
  // -- Client -> server (src/types.ts ClientHelloPayload etc.) --------------
  "client.hello": {
    required: [],
    optional: ["token", "clientId", "clientName", "clientVersion", "platform"],
  },
  "chat.message": { required: ["text"], optional: ["messageId", "role"] },
  "approval.decision": { required: ["approvalId", "decision", "scope"] },
  "session.stop": { required: [], optional: ["reason"] },
  "session.start": {
    required: ["hostId", "agentType", "title"],
    optional: [
      "providerId",
      "launchProfileId",
      "modelId",
      "projectId",
      "resumeId",
      "requestId",
      "initialPrompt",
    ],
  },
  "session.launch": {
    required: [
      "catalogRevision",
      "hostId",
      "agentType",
      "title",
      "providerId",
      "launchProfileId",
      "modelId",
      "permissionProfileId",
      "toolsetId",
    ],
    optional: ["projectId", "resumeId", "requestId", "initialPrompt"],
  },
  "session.request_summary": { required: [] }, // SessionRequestSummaryPayload = Record<string, never>
  "providers.request": { required: [] }, // ProvidersRequestPayload = Record<string, never>
  "projects.request": { required: [] },
  "project.create": { required: ["requestId", "name", "providerId"] },
  "audit.request": { required: [] }, // AuditRequestPayload = Record<string, never>

  // -- Server -> client (src/types.ts Server*Payload) -----------------------
  "server.hello": {
    required: ["serverName", "serverVersion", "protocolVersion", "hostId", "capabilities"],
  },
  "session.snapshot": { required: ["hosts", "sessions"] },
  "providers.snapshot": { required: ["catalogRevision", "providers"] },
  "projects.snapshot": {
    required: ["projects", "resumableSessions"],
    optional: ["creation"],
  },
  "project.created": { required: ["requestId", "project"] },
  "session.created": {
    required: [
      "id",
      "hostId",
      "title",
      "agentType",
      "status",
      "currentSummary",
      "changedFileCount",
      "createdAt",
      "updatedAt",
    ],
    optional: [
      "sessionKind",
      "providerId",
      "launchProfileId",
      "modelId",
      "permissionProfileId",
      "toolsetId",
      "projectId",
      "requestId",
    ],
  },
  "session.updated": {
    required: [],
    optional: ["title", "status", "currentSummary", "changedFileCount", "updatedAt"],
  },
  "agent.status.changed": { required: ["status", "currentSummary"] },
  "terminal.output": { required: ["stream", "text", "sequence"] },
  "activity.summary.updated": { required: ["currentSummary"] },
  "diff.updated": { required: ["changedFileCount", "changedFiles", "diffSummary"] },
  "tests.started": { required: ["testStatus"] },
  "tests.finished": { required: ["testStatus"] },
  "approval.required": {
    required: [
      "approvalId",
      "actionType",
      "command",
      "reason",
      "riskLevel",
      "affectedFiles",
      "recommendation",
    ],
  },
  "approval.resolved": { required: ["approvalId", "decision", "resolvedBy"] },
  "session.completed": { required: ["summary", "changedFileCount", "testStatus"] },
  "session.failed": { required: ["reason", "changedFileCount"] },
  error: { required: ["code", "message", "recoverable"], optional: ["requestId"] },
  // -- Audit log (Phase 10) --------------------------------------------------
  "audit.snapshot": { required: ["events"] },
  "audit.event.created": { required: ["event"] },
};

// NOTE: an earlier revision of this file carried a KNOWN_TYPE_ONLY_DRIFT set
// asserting four client->server fixtures as *expected* drift from
// src/types.ts (clientName/clientVersion/platform, messageId, reason,
// initialPrompt were documented in docs/protocol.md and sent by iOS but not
// declared host-side). Phase 3.5 aligned src/types.ts with the doc and wired
// messageId (chat idempotency), reason (validated), and initialPrompt
// (delivered as the first chat message) into the actual dispatch path, so
// those fixtures are now held to the same exact-match standard as everything
// else.

function keysOf(obj: unknown): string[] {
  if (typeof obj !== "object" || obj === null) return [];
  return Object.keys(obj as Record<string, unknown>).sort();
}

/** The exact key set every Phase 6 `ProviderDescriptor` must have (mirrors src/types.ts). */
const DESCRIPTOR_KEYS = [
  "id",
  "displayName",
  "agentType",
  "enabled",
  "startable",
  "unavailableReason",
  "sandboxMode",
  "sandboxRequired",
  "sandboxSupported",
  "networkPolicy",
  "riskLevel",
  "warnings",
  "launchProfiles",
  "models",
  "permissionProfiles",
  "toolsets",
].sort();

/**
 * Keys (or key substrings) that must NEVER appear anywhere in a provider
 * descriptor — the sensitive execution/config fields the client must not see.
 * `displayName`/`riskLevel` are allow-listed exceptions to the substring match.
 */
const FORBIDDEN_DESCRIPTOR_KEY_SUBSTRINGS = [
  "command",
  "args",
  "env",
  "image",
  "workingdirectory",
  "cwd",
  "token",
  "secret",
  "password",
  "credential",
  "user",
  "engine",
  "config",
];

/** Recursively collect every object key present anywhere in `value`. */
function collectAllKeysDeep(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectAllKeysDeep(item, acc);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      collectAllKeysDeep(v, acc);
    }
  }
  return acc;
}

/** Asserts a providers.snapshot payload is well-formed AND leaks no sensitive fields. */
function assertProvidersPayloadSanitized(payload: unknown, label: string): void {
  const providers = (payload as { providers?: unknown }).providers;
  assert.ok(Array.isArray(providers), `${label}: payload.providers must be an array`);
  for (const [i, descriptor] of (providers as unknown[]).entries()) {
    assert.deepEqual(
      keysOf(descriptor),
      DESCRIPTOR_KEYS,
      `${label}: provider[${i}] key set must exactly match ProviderDescriptor in src/types.ts`,
    );
  }
  // Deep sensitive-field guard: no forbidden key anywhere in the whole payload.
  const allKeys = [...collectAllKeysDeep(payload)];
  const allowed = new Set(["displayName", "riskLevel"]); // legit keys that contain a forbidden substring
  for (const key of allKeys) {
    if (allowed.has(key)) continue;
    const lower = key.toLowerCase();
    for (const forbidden of FORBIDDEN_DESCRIPTOR_KEY_SUBSTRINGS) {
      assert.equal(
        lower.includes(forbidden),
        false,
        `${label}: forbidden key "${key}" (contains "${forbidden}") present — provider descriptors must never expose execution/config fields`,
      );
    }
  }
}

describe("providers.snapshot descriptor sanitization (Phase 6, fixture)", () => {
  test("every fixture descriptor has the exact key set and no sensitive fields", () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, "providers.snapshot.json"), "utf8"),
    ) as Envelope<unknown>;
    assertProvidersPayloadSanitized(fixture.payload, "providers.snapshot.json");
  });
});

const PROJECT_DESCRIPTOR_KEYS = [
  "id",
  "hostId",
  "displayName",
  "providerIds",
  "defaultProviderId",
  "startable",
  "riskLevel",
  "warnings",
  "resumableSessionCount",
].sort();
const RESUME_DESCRIPTOR_KEYS = [
  "id",
  "projectId",
  "providerId",
  "title",
  "agentType",
  "updatedAt",
].sort();
const PROJECT_CREATION_KEYS = ["providerIds", "maxNameLength"].sort();

describe("projects.snapshot sanitization", () => {
  test("fixture carries only opaque project/resume metadata", () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, "projects.snapshot.json"), "utf8"),
    ) as {
      payload: {
        projects: unknown[];
        resumableSessions: unknown[];
        creation?: unknown;
      };
    };
    for (const project of fixture.payload.projects) {
      assert.deepEqual(keysOf(project), PROJECT_DESCRIPTOR_KEYS);
    }
    for (const session of fixture.payload.resumableSessions) {
      assert.deepEqual(keysOf(session), RESUME_DESCRIPTOR_KEYS);
    }
    if (fixture.payload.creation !== null && fixture.payload.creation !== undefined) {
      assert.deepEqual(keysOf(fixture.payload.creation), PROJECT_CREATION_KEYS);
    }
    const wire = JSON.stringify(fixture.payload).toLowerCase();
    for (const forbidden of [
      '"path"',
      '"cwd"',
      '"workingdirectory"',
      '"command"',
      '"args"',
      '"env"',
      '"token"',
      '"threadid"',
      '"sessionid"',
    ]) {
      assert.equal(wire.includes(forbidden), false, `projects.snapshot leaked ${forbidden}`);
    }
  });
});

function assertEnvelopeShape(envelope: unknown, fixtureName: string): asserts envelope is Envelope<unknown> {
  const env = envelope as Record<string, unknown>;
  assert.equal(typeof env["type"], "string", `${fixtureName}: envelope.type must be a string`);
  assert.equal(env["version"], 1, `${fixtureName}: envelope.version must be 1`);
  assert.equal(typeof env["timestamp"], "string", `${fixtureName}: envelope.timestamp must be a string`);
  assert.ok(
    !Number.isNaN(Date.parse(env["timestamp"] as string)),
    `${fixtureName}: envelope.timestamp must be a parseable date`,
  );
  assert.ok(
    typeof env["sessionId"] === "string" || env["sessionId"] === null,
    `${fixtureName}: envelope.sessionId must be a string or null`,
  );
  assert.ok(
    typeof env["payload"] === "object" && env["payload"] !== null,
    `${fixtureName}: envelope.payload must be an object`,
  );
}

/**
 * Asserts that `payload`'s key set conforms to `spec`: every required key is
 * present, and every present key is either required or a known optional
 * field (i.e. no unrecognized/extra keys). Returns a diagnostic-friendly
 * failure rather than the raw assert message.
 */
function assertKeysMatchSpec(payload: unknown, spec: KeySpec, label: string): void {
  const actualKeys = new Set(keysOf(payload));
  const allowedKeys = new Set([...spec.required, ...(spec.optional ?? [])]);

  const missingRequired = spec.required.filter((k) => !actualKeys.has(k));
  const unexpectedKeys = [...actualKeys].filter((k) => !allowedKeys.has(k));

  assert.deepEqual(
    missingRequired,
    [],
    `${label}: payload is missing required keys per src/types.ts: ${JSON.stringify(missingRequired)}. ` +
      `Actual keys: ${JSON.stringify([...actualKeys].sort())}`,
  );
  assert.deepEqual(
    unexpectedKeys,
    [],
    `${label}: payload has keys not declared in src/types.ts: ${JSON.stringify(unexpectedKeys)}. ` +
      `Actual keys: ${JSON.stringify([...actualKeys].sort())}`,
  );
}

describe("fixture envelope shape + payload key-set vs. src/types.ts", () => {
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  assert.ok(fixtureFiles.length > 0, `expected to find fixture JSON files in ${FIXTURES_DIR}`);

  for (const file of fixtureFiles) {
    test(`${file}: envelope is well-formed`, () => {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8");
      const envelope: unknown = JSON.parse(raw);
      assertEnvelopeShape(envelope, file);
    });

    test(`${file}: payload key set vs. src/types.ts`, () => {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8");
      const envelope = JSON.parse(raw) as Envelope<unknown>;
      const spec = EXPECTED_PAYLOAD_KEYS[envelope.type];
      assert.ok(spec, `${file}: no EXPECTED_PAYLOAD_KEYS entry for type "${envelope.type}" — add one, mirrored from src/types.ts`);

      assertKeysMatchSpec(envelope.payload, spec, file);
    });
  }
});

// ---------------------------------------------------------------------------
// Real runtime cross-check: does the host-agent's *actual* emitted envelope
// for a given type have the same key set as the fixture for that type? This
// is the check that would have caught the original protocol drift bug,
// since it doesn't rely on src/types.ts being correct — it directly diffs
// two independently-authored JSON shapes (the fixture and the real wire
// output).
// ---------------------------------------------------------------------------

describe("live server output vs. fixtures (real regression guard)", () => {
  let server: TestServer;
  let client: TestWsClient;
  const observed = new Map<string, Envelope<unknown>>();

  before(async () => {
    server = await startTestServer();
    client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
    await client.waitForOpen();

    const hello = await client.waitFor((e) => e.type === "server.hello");
    observed.set("server.hello", hello);
    const snapshot = await client.waitFor((e) => e.type === "session.snapshot");
    observed.set("session.snapshot", snapshot);
    const providers = await client.waitFor((e) => e.type === "providers.snapshot");
    observed.set("providers.snapshot", providers);
    const projects = await client.waitFor((e) => e.type === "projects.snapshot");
    observed.set("projects.snapshot", projects);

    const snapshotPayload = snapshot.payload as { hosts: HostInfo[]; sessions: AgentSession[] };
    const host = snapshotPayload.hosts[0];
    assert.ok(host, "expected at least one seeded host in session.snapshot");

    const chatTarget =
      snapshotPayload.sessions.find((s) => s.status !== "completed" && s.status !== "failed") ??
      snapshotPayload.sessions[0];
    assert.ok(chatTarget, "expected at least one seeded session for chat.message cross-check");
    client.send({
      type: "chat.message",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: chatTarget.id,
      payload: { messageId: "contract_chat_1", text: "please add a test" },
    });
    const assistantChat = await client.waitFor(
      (e) =>
        e.type === "chat.message" &&
        e.sessionId === chatTarget.id &&
        (e.payload as { role?: string }).role === "assistant",
      5000,
    );
    observed.set("chat.message", assistantChat);

    // Drive one full lifecycle run to observe every remaining event type of
    // interest. Retry with fresh sessions (stopping ones that don't pan
    // out) until a "completes" scenario is hit, same rationale as
    // tests/session-lifecycle.test.ts.
    const maxAttempts = 6;
    let succeeded = false;
    for (let attempt = 1; attempt <= maxAttempts && !succeeded; attempt++) {
      client.send({
        type: "session.start",
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: null,
        payload: {
          hostId: host.id,
          agentType: "claudeCode",
          title: `Contract test run ${attempt}`,
          requestId: "start_fixture_001",
        },
      });

      const created = await client.waitFor((e) => e.type === "session.created", 5000);
      observed.set("session.created", created);
      const sessionId = created.sessionId!;

      try {
        const statusChanged = await client.waitFor(
          (e) => e.type === "agent.status.changed" && e.sessionId === sessionId,
          10_000,
        );
        observed.set("agent.status.changed", statusChanged);

        const terminalOutput = await client.waitFor(
          (e) => e.type === "terminal.output" && e.sessionId === sessionId,
          10_000,
        );
        observed.set("terminal.output", terminalOutput);

        const approvalRequired = await client.waitFor(
          (e) => e.type === "approval.required" && e.sessionId === sessionId,
          12_000,
        );
        observed.set("approval.required", approvalRequired);
        const approvalPayload = approvalRequired.payload as { approvalId: string };

        client.send({
          type: "approval.decision",
          version: 1,
          timestamp: new Date().toISOString(),
          sessionId,
          payload: { approvalId: approvalPayload.approvalId, decision: "approve", scope: "once" },
        });

        const approvalResolved = await client.waitFor(
          (e) => e.type === "approval.resolved" && e.sessionId === sessionId,
          5000,
        );
        observed.set("approval.resolved", approvalResolved);

        const terminalEnvelope = await client.waitFor(
          (e) =>
            (e.type === "session.completed" || e.type === "session.failed") &&
            e.sessionId === sessionId,
          20_000,
        );
        observed.set(terminalEnvelope.type, terminalEnvelope);
        succeeded = true;
      } catch {
        // This attempt's scenario didn't cooperate (e.g. "stuck"/"failed"
        // before reaching approval); stop it and try again with a fresh
        // session rather than leaving it running in the background.
        client.send({
          type: "session.stop",
          version: 1,
          timestamp: new Date().toISOString(),
          sessionId,
          payload: {},
        });
      }
    }

    assert.ok(
      observed.has("approval.required") && observed.has("approval.resolved"),
      "expected at least one session.start attempt to reach approval.required/approval.resolved",
    );

    // Force an `error` envelope by sending an unknown event type.
    client.send({
      type: "totally.unknown.event.for.contract.test",
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: null,
      payload: {},
    });
    const errorEnvelope = await client.waitFor((e) => e.type === "error");
    observed.set("error", errorEnvelope);
  });

  after(async () => {
    client.close();
    await server.close();
  });

  const typesToCrossCheck = [
    { type: "server.hello", fixture: "server.hello.json" },
    { type: "session.snapshot", fixture: "session.snapshot.json" },
    { type: "providers.snapshot", fixture: "providers.snapshot.json" },
    { type: "projects.snapshot", fixture: "projects.snapshot.json" },
    { type: "chat.message", fixture: "chat.message.assistant.json" },
    { type: "session.created", fixture: "session.created.json" },
    { type: "agent.status.changed", fixture: "agent.status.changed.json" },
    { type: "terminal.output", fixture: "terminal.output.json" },
    { type: "approval.required", fixture: "approval.required.json" },
    { type: "approval.resolved", fixture: "approval.resolved.json" },
    { type: "session.completed", fixture: "session.completed.json" }, // may be absent if the observed run ended in session.failed instead
    { type: "error", fixture: "error.json" },
  ];

  for (const { type, fixture: fixtureFile } of typesToCrossCheck) {
    test(`${type}: live-emitted payload key set matches the fixture's`, () => {
      const fixturePath = path.join(FIXTURES_DIR, fixtureFile);
      const fixtureEnvelope = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Envelope<unknown>;
      const fixtureKeys = keysOf(fixtureEnvelope.payload);

      const liveEnvelope = observed.get(type);
      if (type === "session.completed" && !liveEnvelope) {
        // The mock's "completes" scenario should have produced this in the
        // `before()` hook above; if it's missing, something is genuinely
        // wrong (not just "the run happened to fail instead"), since we
        // specifically waited for approval.required/approval.resolved
        // before expecting completion. Fail loudly rather than skip.
        assert.fail(
          "expected a live session.completed envelope to have been observed after an approved lifecycle",
        );
      }
      assert.ok(liveEnvelope, `expected to have observed a live "${type}" envelope during the before() hook`);

      const liveKeys = keysOf(liveEnvelope.payload);
      assert.deepEqual(
        liveKeys,
        fixtureKeys,
        `${type}: live-emitted payload keys ${JSON.stringify(liveKeys)} do not match ` +
          `fixture payload keys ${JSON.stringify(fixtureKeys)} — this is the real host-agent-output-vs-fixture ` +
          `regression this test exists to catch.`,
      );
    });
  }

  test("live providers.snapshot descriptors are sanitized (no execution/config fields leak)", () => {
    const live = observed.get("providers.snapshot");
    assert.ok(live, "expected to have observed a live providers.snapshot envelope");
    assertProvidersPayloadSanitized(live.payload, "live providers.snapshot");
  });

  test("live session.snapshot nested session key set matches the fixture's", () => {
    const live = observed.get("session.snapshot");
    assert.ok(live, "expected to have observed a live session.snapshot envelope");
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, "session.snapshot.json"), "utf8"),
    ) as Envelope<{ sessions: unknown[] }>;
    const liveSessions = (live.payload as { sessions?: unknown[] }).sessions ?? [];
    const fixtureSession = fixture.payload.sessions[0];
    const liveSession = liveSessions[0];
    assert.ok(fixtureSession, "fixture should include at least one nested session");
    assert.ok(liveSession, "live snapshot should include at least one nested session");
    assert.deepEqual(keysOf(liveSession), keysOf(fixtureSession));
    assert.ok(keysOf(liveSession).includes("sessionKind"), "sessionKind must stay in snapshot session objects");
  });
});
