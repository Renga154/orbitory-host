/**
 * Audit event store (Phase 10).
 *
 * Append-only JSONL of sanitized supervision events (see `docs/security.md` §8).
 * The store keeps a capped in-memory ring buffer (fast `GET /audit` + snapshots)
 * and appends each event as one JSON line. It is fail-safe on load: a
 * missing/corrupt/partial file yields whatever valid lines it can, never throws.
 *
 * SECURITY: events are HOST-AUTHORED safe metadata only — the store persists
 * exactly what `record()` is given. It is the caller's job (see `audit.ts`) to
 * never pass raw secrets/tokens/keys/env/command/output; `details` is limited to
 * primitive values by the type. Runtime logs are gitignored.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import type { AuditActor, AuditEvent, AuditEventType, AuditSeverity, Localized } from "./types.js";

export const AUDIT_EVENT_VERSION = 1;

/** Persistence backend (file in prod, in-memory in tests). */
export interface AuditPersistence {
  /** Most-recent up to `max` events, newest-last. Never throws. */
  loadRecent(max: number): AuditEvent[];
  append(event: AuditEvent): void;
}

export class MemoryAuditPersistence implements AuditPersistence {
  readonly events: AuditEvent[] = [];
  loadRecent(max: number): AuditEvent[] {
    return this.events.slice(-max);
  }
  append(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** Append-only JSONL file persistence. Corrupt lines are skipped (fail safe). */
export class FileAuditPersistence implements AuditPersistence {
  constructor(private readonly path: string) {}

  loadRecent(max: number): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const out: AuditEvent[] = [];
    for (const line of lines.slice(-max)) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAuditEventShape(parsed)) out.push(parsed);
        // else: a JSON line that isn't our shape — skip, never crash.
      } catch {
        // Corrupt/partial line (e.g. a torn final write) — skip, fail safe.
      }
    }
    return out;
  }

  append(event: AuditEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}

/** Minimal shape guard so a foreign/corrupt JSON line is skipped on load. */
function isAuditEventShape(v: unknown): v is AuditEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["type"] === "string" &&
    typeof e["timestamp"] === "string" &&
    typeof e["severity"] === "string"
  );
}

export interface RecordAuditParams {
  type: AuditEventType;
  severity: AuditSeverity;
  actor: AuditActor;
  hostId: string;
  sessionId?: string | null;
  providerId?: string | null;
  agentType?: string | null;
  summary?: Localized | null;
  details?: Record<string, string | number | boolean> | null;
  redactionState?: "none" | "redacted";
  correlationId?: string | null;
}

export interface AuditFilter {
  limit?: number;
  sessionId?: string;
  providerId?: string;
  since?: string;
}

export interface AuditStoreOptions {
  persistence: AuditPersistence;
  /** In-memory ring-buffer cap (and startup load count). */
  max?: number;
  now?: () => Date;
  generateId?: () => string;
}

export class AuditStore {
  private buffer: AuditEvent[];
  private readonly max: number;
  private readonly persistence: AuditPersistence;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private onRecordedCb: ((event: AuditEvent) => void) | null = null;

  constructor(opts: AuditStoreOptions) {
    this.persistence = opts.persistence;
    this.max = opts.max && opts.max > 0 ? opts.max : 500;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? (() => `audit_${randomBytes(8).toString("hex")}`);
    this.buffer = this.persistence.loadRecent(this.max);
  }

  /** Register a callback invoked after each `record()` (used to broadcast live). */
  onRecorded(cb: (event: AuditEvent) => void): void {
    this.onRecordedCb = cb;
  }

  record(params: RecordAuditParams): AuditEvent {
    const event: AuditEvent = {
      id: this.generateId(),
      version: AUDIT_EVENT_VERSION,
      timestamp: this.now().toISOString(),
      type: params.type,
      severity: params.severity,
      actor: params.actor,
      hostId: params.hostId,
      sessionId: params.sessionId ?? null,
      providerId: params.providerId ?? null,
      agentType: params.agentType ?? null,
      summary: params.summary ?? null,
      details: params.details ?? null,
      redactionState: params.redactionState ?? "none",
      correlationId: params.correlationId ?? null,
    };
    this.persistence.append(event);
    this.buffer.push(event);
    if (this.buffer.length > this.max) {
      this.buffer = this.buffer.slice(-this.max);
    }
    try {
      this.onRecordedCb?.(event);
    } catch {
      // A broadcast failure must never break recording.
    }
    return event;
  }

  /** Filtered view of the in-memory buffer, newest-last. */
  list(filter?: AuditFilter): AuditEvent[] {
    let events = this.buffer;
    if (filter?.sessionId) {
      events = events.filter((e) => e.sessionId === filter.sessionId);
    }
    if (filter?.providerId) {
      events = events.filter((e) => e.providerId === filter.providerId);
    }
    if (filter?.since) {
      const sinceMs = Date.parse(filter.since);
      if (!Number.isNaN(sinceMs)) {
        events = events.filter((e) => Date.parse(e.timestamp) >= sinceMs);
      }
    }
    if (filter?.limit !== undefined && Number.isInteger(filter.limit) && filter.limit >= 0) {
      // NB: slice(-0) === slice(0) returns the WHOLE array, so limit 0 must be
      // special-cased to mean "no events" rather than "all events".
      events = filter.limit === 0 ? [] : events.slice(-filter.limit);
    }
    return events;
  }

  /** The most-recent up to `max` events (for snapshots). */
  recent(max = this.max): AuditEvent[] {
    return this.buffer.slice(-max);
  }
}
