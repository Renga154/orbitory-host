/**
 * Per-device pairing tokens (Phase 8).
 *
 * Replaces "one static shared secret forever" with per-device tokens that are
 * hashed at rest, expire, and can be revoked. A pairing operation issues a fresh
 * random token, registers only its SHA-256 hash (+ metadata) in a store, and
 * hands the RAW token back exactly once so it can be embedded in the pairing code.
 * The raw token is never persisted and never logged.
 *
 * SECURITY:
 * - Raw tokens exist only transiently at issuance; the store keeps hashes only.
 * - `verify()` rejects unknown / expired / revoked tokens.
 * - The store is load-through (every op reads persistence, mutates, writes back)
 *   so a token issued by the `pairing:print` CLI is visible to a separately
 *   running server process.
 *
 * The static `ORBITORY_PAIRING_TOKEN` is handled separately, in `auth.ts`, as a
 * documented lower-security dev-compatibility fallback — it is NOT stored here.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Current on-disk schema version for the paired-devices store. */
export const PAIRED_DEVICES_STORE_VERSION = 1;

/**
 * A paired-device record as persisted. `tokenHash` is a SHA-256 of the raw
 * token; the raw token itself is never stored.
 */
export interface PairedDeviceRecord {
  id: string;
  deviceName: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** ISO 8601; `null` only when the token was issued with TTL disabled (dev). */
  expiresAt: string | null;
  /** ISO 8601 when revoked, else `null`. */
  revokedAt: string | null;
}

/** A record view safe to show/log — never includes `tokenHash`. */
export type PublicDeviceRecord = Omit<PairedDeviceRecord, "tokenHash">;

export interface StoreData {
  version: number;
  devices: PairedDeviceRecord[];
}

export type VerifyFailureReason = "missing" | "unknown" | "expired" | "revoked";

export type VerifyResult =
  | { ok: true; record: PublicDeviceRecord }
  | { ok: false; reason: VerifyFailureReason };

/** Persistence backend for the store (file-backed in prod, in-memory in tests). */
export interface Persistence {
  load(): StoreData;
  save(data: StoreData): void;
}

function emptyStore(): StoreData {
  return { version: PAIRED_DEVICES_STORE_VERSION, devices: [] };
}

/** In-memory persistence — no filesystem, no pollution. For tests. */
export class MemoryPersistence implements Persistence {
  private data: StoreData;
  constructor(initial?: StoreData) {
    this.data = initial ?? emptyStore();
  }
  load(): StoreData {
    // Return a structural copy so callers can't mutate our backing store
    // except through save() (mirrors the file-backed semantics).
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }
  save(data: StoreData): void {
    this.data = JSON.parse(JSON.stringify(data)) as StoreData;
  }
}

/**
 * File-backed persistence. A missing or corrupt file loads as empty (fail-safe:
 * no device tokens accepted, so the static dev token remains the only way in —
 * the safe/deny direction), with a redacted warning; it never throws on load.
 */
export class FilePersistence implements Persistence {
  constructor(private readonly path: string) {}
  load(): StoreData {
    if (!existsSync(this.path)) {
      return emptyStore();
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoreData;
      if (!parsed || !Array.isArray(parsed.devices)) {
        return emptyStore();
      }
      return parsed;
    } catch {
      // Never include file contents (could contain hashes/metadata) in the log.
      console.warn(
        `[orbitory-host-agent] paired-devices store at ${this.path} is unreadable/corrupt; treating as empty.`,
      );
      return emptyStore();
    }
  }
  save(data: StoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }
}

/** SHA-256 hex of a raw token. Lookups are by this hash; raw tokens never persist. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("base64url");
}

function defaultGenerateId(): string {
  return `dev_${randomBytes(8).toString("hex")}`;
}

function toPublic(record: PairedDeviceRecord): PublicDeviceRecord {
  const { tokenHash: _omit, ...pub } = record;
  void _omit;
  return pub;
}

export interface PairedDeviceStoreOptions {
  persistence: Persistence;
  /** Injectable clock for deterministic tests. Defaults to the real clock. */
  now?: () => Date;
  generateId?: () => string;
  generateToken?: () => string;
}

export interface IssueParams {
  deviceName: string;
  /** Seconds until expiry. `<= 0` disables expiry (`expiresAt: null`). */
  ttlSeconds: number;
}

/**
 * Load-through store of per-device pairing tokens. Every operation reads the
 * current persisted state, mutates, and writes it back, so multiple processes
 * (the server and the `pairing:print` CLI) stay consistent.
 */
export class PairedDeviceStore {
  private readonly persistence: Persistence;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly generateToken: () => string;

  constructor(opts: PairedDeviceStoreOptions) {
    this.persistence = opts.persistence;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? defaultGenerateId;
    this.generateToken = opts.generateToken ?? defaultGenerateToken;
  }

  /** Issue a new device token. Returns the RAW token once (never persisted). */
  issue(params: IssueParams): { record: PublicDeviceRecord; rawToken: string } {
    const deviceName = params.deviceName.trim() || "Unnamed device";
    const rawToken = this.generateToken();
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const expiresAt =
      params.ttlSeconds > 0
        ? new Date(nowDate.getTime() + params.ttlSeconds * 1000).toISOString()
        : null;

    const record: PairedDeviceRecord = {
      id: this.generateId(),
      deviceName,
      tokenHash: hashToken(rawToken),
      createdAt: nowIso,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    };

    const data = this.persistence.load();
    data.devices.push(record);
    this.persistence.save(data);

    return { record: toPublic(record), rawToken };
  }

  /**
   * Verify a presented raw token. Rejects unknown / revoked / expired tokens;
   * on success stamps `lastUsedAt` (best-effort) and returns the public record.
   */
  verify(rawToken: string | undefined | null): VerifyResult {
    if (!rawToken) {
      return { ok: false, reason: "missing" };
    }
    const presentedHash = hashToken(rawToken);
    const data = this.persistence.load();
    const record = data.devices.find((d) => d.tokenHash === presentedHash);
    if (!record) {
      return { ok: false, reason: "unknown" };
    }
    if (record.revokedAt !== null) {
      return { ok: false, reason: "revoked" };
    }
    if (record.expiresAt !== null) {
      const expiryMs = Date.parse(record.expiresAt);
      // Fail safe: a corrupt/tampered, non-null `expiresAt` that doesn't parse to a
      // real instant is treated as EXPIRED (deny), never as never-expiring. Without
      // this guard, `now > NaN` is always false and the token would authenticate
      // forever — the opposite of the store's documented fail-safe posture.
      if (Number.isNaN(expiryMs) || this.now().getTime() > expiryMs) {
        return { ok: false, reason: "expired" };
      }
    }
    record.lastUsedAt = this.now().toISOString();
    this.persistence.save(data);
    return { ok: true, record: toPublic(record) };
  }

  /** Revoke a device token by id. Returns true if a matching, not-yet-revoked record was revoked. */
  revoke(id: string): boolean {
    const data = this.persistence.load();
    const record = data.devices.find((d) => d.id === id);
    if (!record || record.revokedAt !== null) {
      return false;
    }
    record.revokedAt = this.now().toISOString();
    this.persistence.save(data);
    return true;
  }

  /** All records as public views (never raw tokens or hashes). */
  list(): PublicDeviceRecord[] {
    return this.persistence.load().devices.map(toPublic);
  }
}
