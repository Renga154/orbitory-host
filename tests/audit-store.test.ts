/**
 * Phase 10 — AuditStore unit tests (persistence, filters, corrupt-safe load, cap).
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  AuditStore,
  FileAuditPersistence,
  MemoryAuditPersistence,
} from "../src/auditStore.js";

function makeStore(persistence = new MemoryAuditPersistence(), max?: number) {
  let clock = new Date("2026-07-04T00:00:00.000Z");
  let n = 0;
  const store = new AuditStore({
    persistence,
    max,
    now: () => clock,
    generateId: () => `audit_${++n}`,
  });
  return {
    store,
    persistence,
    setClock: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

describe("audit-store: record", () => {
  test("assigns id/version/timestamp and defaults optional fields to null", () => {
    const { store } = makeStore();
    const e = store.record({ type: "session.started", severity: "info", actor: "agent", hostId: "h" });
    assert.equal(e.id, "audit_1");
    assert.equal(e.version, 1);
    assert.equal(e.timestamp, "2026-07-04T00:00:00.000Z");
    assert.equal(e.sessionId, null);
    assert.equal(e.providerId, null);
    assert.equal(e.summary, null);
    assert.equal(e.details, null);
    assert.equal(e.redactionState, "none");
    assert.equal(e.correlationId, null);
  });

  test("invokes the onRecorded callback (for live broadcast)", () => {
    const { store } = makeStore();
    const seen: string[] = [];
    store.onRecorded((e) => seen.push(e.type));
    store.record({ type: "approval.required", severity: "high", actor: "agent", hostId: "h" });
    assert.deepEqual(seen, ["approval.required"]);
  });
});

describe("audit-store: list filters", () => {
  test("filters by sessionId, providerId, since, and limit", () => {
    const { store, setClock } = makeStore();
    setClock("2026-07-04T00:00:00.000Z");
    store.record({ type: "session.started", severity: "info", actor: "agent", hostId: "h", sessionId: "s1" });
    setClock("2026-07-04T00:01:00.000Z");
    store.record({ type: "provider.start.rejected", severity: "warning", actor: "host", hostId: "h", providerId: "p1" });
    setClock("2026-07-04T00:02:00.000Z");
    store.record({ type: "session.completed", severity: "info", actor: "agent", hostId: "h", sessionId: "s1" });

    assert.equal(store.list({ sessionId: "s1" }).length, 2);
    assert.equal(store.list({ providerId: "p1" }).length, 1);
    assert.equal(store.list({ since: "2026-07-04T00:01:30.000Z" }).length, 1);
    assert.equal(store.list({ limit: 1 }).length, 1);
    assert.equal(store.list({ limit: 1 })[0].type, "session.completed", "limit keeps newest");
  });

  test("limit=0 returns no events (not the whole buffer via slice(-0))", () => {
    const { store } = makeStore();
    store.record({ type: "session.started", severity: "info", actor: "agent", hostId: "h" });
    store.record({ type: "session.completed", severity: "info", actor: "agent", hostId: "h" });
    assert.equal(store.list({ limit: 0 }).length, 0, "limit 0 means zero events, not all of them");
    assert.equal(store.list({ limit: 2 }).length, 2);
  });
});

describe("audit-store: cap (ring buffer)", () => {
  test("keeps only the most-recent `max` events in memory", () => {
    const { store } = makeStore(new MemoryAuditPersistence(), 3);
    for (let i = 0; i < 5; i++) {
      store.record({ type: "system.warning", severity: "warning", actor: "system", hostId: "h" });
    }
    const recent = store.recent();
    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map((e) => e.id), ["audit_3", "audit_4", "audit_5"]);
  });
});

describe("audit-store: file persistence", () => {
  const path = join(tmpdir(), `orbitory-audit-${randomBytes(6).toString("hex")}.jsonl`);
  afterEach(() => {
    if (existsSync(path)) rmSync(path);
  });

  test("appends one JSON line per event and reloads them", () => {
    const a = new AuditStore({ persistence: new FileAuditPersistence(path) });
    a.record({ type: "session.started", severity: "info", actor: "agent", hostId: "h", sessionId: "s1" });
    a.record({ type: "session.completed", severity: "info", actor: "agent", hostId: "h", sessionId: "s1" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    // A fresh store reads the same file.
    const b = new AuditStore({ persistence: new FileAuditPersistence(path) });
    assert.equal(b.recent().length, 2);
    assert.equal(b.recent()[0].type, "session.started");
  });

  test("fails safe on corrupt/partial lines (skips them, never throws)", () => {
    const p = new FileAuditPersistence(path);
    p.append({
      id: "audit_ok",
      version: 1,
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "session.started",
      severity: "info",
      actor: "agent",
      hostId: "h",
      sessionId: null,
      providerId: null,
      agentType: null,
      summary: null,
      details: null,
      redactionState: "none",
      correlationId: null,
    });
    // Corrupt: a torn line + a non-audit JSON line.
    writeFileSync(path, `${readFileSync(path, "utf8")}{ not json\n{"foo":"bar"}\n`);
    const loaded = p.loadRecent(500);
    assert.equal(loaded.length, 1, "only the valid audit line survives");
    assert.equal(loaded[0].id, "audit_ok");
  });

  test("a missing file loads as empty", () => {
    const missing = new FileAuditPersistence(join(tmpdir(), `nope-${randomBytes(4).toString("hex")}.jsonl`));
    assert.deepEqual(missing.loadRecent(500), []);
  });
});
