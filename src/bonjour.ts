/**
 * Bonjour / mDNS host discovery advertisement (Phase 13).
 *
 * Lets a device on the same local network *discover* that an Orbitory host-agent
 * is reachable — **not** authenticate to it. Discovery grants nothing: pairing
 * (per-device token, and optionally TLS-fingerprint pinning) is still required.
 *
 * This module is intentionally config-agnostic and network-agnostic so it is
 * fully unit-testable:
 *
 *   - `buildBonjourAdvertisement()` is a PURE function and the single choke point
 *     that constructs the advertised TXT record. It copies ONLY named, safe
 *     fields — there is structurally no path for a token, provider config,
 *     command, path, or any secret to enter the advertisement (same discipline
 *     as `pairing.ts` and `agentConfig.ts`'s sanitized descriptors).
 *   - `BonjourAdvertiser` wraps an INJECTABLE `BonjourBackend`. Tests inject a
 *     fake backend; the real backend (`createDefaultBonjourBackend`) lazily
 *     `import()`s the `bonjour-service` library, so nothing binds an mDNS socket
 *     unless advertisement is actually enabled at runtime.
 *
 * See `docs/PHASE13_BONJOUR_HOST_DISCOVERY.md` and `docs/security.md`.
 */

import os from "node:os";

/** Canonical default mDNS service type advertised by Orbitory. */
export const BONJOUR_DEFAULT_SERVICE_TYPE = "_orbitory._tcp";

/** A well-formed mDNS service type looks like `_name._tcp` / `_name._udp`. */
export function isValidBonjourServiceType(raw: string): boolean {
  return /^_[a-z0-9-]+\._(tcp|udp)$/.test(raw);
}

/**
 * Normalize an operator-supplied service type. Returns the default (and flags
 * `wasInvalid`) for anything that isn't a well-formed mDNS service type — a
 * malformed value is almost always a config mistake, and advertising something
 * malformed is worse than falling back.
 */
export function normalizeBonjourServiceType(raw: string | undefined): {
  serviceType: string;
  wasInvalid: boolean;
} {
  const trimmed = raw?.trim();
  if (!trimmed) return { serviceType: BONJOUR_DEFAULT_SERVICE_TYPE, wasInvalid: false };
  if (isValidBonjourServiceType(trimmed)) return { serviceType: trimmed, wasInvalid: false };
  return { serviceType: BONJOUR_DEFAULT_SERVICE_TYPE, wasInvalid: true };
}

/**
 * Parse an optional advertised-port override. `undefined` means "use the
 * effective server listen port"; a non-integer / non-positive value is flagged
 * invalid and treated as unset.
 */
export function parseBonjourPort(raw: string | undefined): {
  port: number | undefined;
  wasInvalid: boolean;
} {
  const trimmed = raw?.trim();
  if (!trimmed) return { port: undefined, wasInvalid: false };
  const parsed = Number(trimmed);
  // Ports are 16-bit; anything non-integer, non-positive, or > 65535 is invalid.
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return { port: undefined, wasInvalid: true };
  }
  return { port: parsed, wasInvalid: false };
}

/** Everything the pure TXT builder needs. Only these fields ever reach the wire. */
export interface BonjourAdvertisementInput {
  /** Human-readable service name (e.g. "Renga MacBook Pro"). */
  serviceName: string;
  /** Full mDNS service type, e.g. `_orbitory._tcp`. */
  serviceType: string;
  /** Port advertised in the SRV record (effective listen port or override). */
  port: number;
  /** Informational host id — `os.hostname()`. Not a security boundary. */
  hostId: string;
  /** Display label (usually equal to `serviceName`). */
  hostName: string;
  /** Whether the advertised port serves HTTPS/WSS. A hint only — never trust. */
  tls: boolean;
  /** Plaintext port; included ONLY when `tls` is false. */
  httpPort?: number;
  /** TLS port; included ONLY when `tls` is true. */
  httpsPort?: number;
  /** WebSocket path (e.g. `/ws`). */
  wsPath: string;
  /** Host-agent server version (informational). */
  version: string;
}

/** A fully-resolved, backend-agnostic service definition. */
export interface BonjourServiceDefinition {
  name: string;
  /** Full service type, e.g. `_orbitory._tcp`. */
  serviceType: string;
  port: number;
  /** Safe TXT metadata only (see `buildBonjourAdvertisement`). */
  txt: Record<string, string>;
}

/**
 * THE security choke point. Builds the advertised service + TXT record from
 * named safe fields ONLY. There is deliberately no spread of an arbitrary
 * object and no branch that can copy a token / command / env / path / provider
 * config into the TXT record. Exactly one of `httpport` / `httpsport` is present,
 * matching `tls` (the single-transport rule the server enforces).
 */
export function buildBonjourAdvertisement(input: BonjourAdvertisementInput): BonjourServiceDefinition {
  const txt: Record<string, string> = {
    product: "Orbitory",
    txtvers: "1",
    version: input.version,
    hostid: input.hostId,
    hostname: input.hostName,
    tls: input.tls ? "true" : "false",
    wspath: input.wsPath,
    pairing: "required",
  };
  if (input.tls) {
    if (input.httpsPort !== undefined) txt.httpsport = String(input.httpsPort);
  } else if (input.httpPort !== undefined) {
    txt.httpport = String(input.httpPort);
  }
  return {
    name: input.serviceName,
    serviceType: input.serviceType,
    port: input.port,
    txt,
  };
}

/** Resolve the advertised host id/name (injectable hostname for tests). */
export function resolveBonjourNames(params: {
  bonjourName: string | undefined;
  hostname?: string;
}): { hostId: string; serviceName: string } {
  const host = params.hostname ?? os.hostname();
  const serviceName = params.bonjourName ?? host;
  return { hostId: host, serviceName };
}

/** Handle to an active advertisement; `stop()` withdraws it. */
export interface BonjourPublishHandle {
  stop(): Promise<void> | void;
}

/** The injectable Bonjour backend the advertiser drives. */
export interface BonjourBackend {
  publish(def: BonjourServiceDefinition): BonjourPublishHandle | Promise<BonjourPublishHandle>;
  /** Tear down the backend entirely (called on stop). */
  shutdown(): Promise<void> | void;
}

/**
 * Thin lifecycle wrapper over a `BonjourBackend`. Owns start/stop and clear
 * logging; holds no mDNS knowledge itself.
 */
export class BonjourAdvertiser {
  private handle: BonjourPublishHandle | null = null;
  private backend: BonjourBackend | null = null;

  constructor(
    private readonly def: BonjourServiceDefinition,
    private readonly backendFactory: () => BonjourBackend | Promise<BonjourBackend>,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {}

  async start(): Promise<void> {
    const backend = await this.backendFactory();
    this.backend = backend;
    this.handle = await backend.publish(this.def);
    this.log(
      `[orbitory] bonjour: advertising "${this.def.name}" as ${this.def.serviceType} on :${this.def.port} (tls=${this.def.txt.tls ?? "false"})`,
    );
  }

  async stop(): Promise<void> {
    try {
      await this.handle?.stop();
      await this.backend?.shutdown();
    } finally {
      this.handle = null;
      this.backend = null;
    }
    this.log("[orbitory] bonjour: stopped advertising");
  }
}

export interface StartBonjourOptions {
  /** The resolved service definition, or `null` to skip (disabled). */
  def: BonjourServiceDefinition | null;
  /** When true, a start failure is fatal (fail-closed) rather than best-effort. */
  required: boolean;
  /** Injectable backend factory; defaults to the real `bonjour-service` backend. */
  backendFactory?: () => BonjourBackend | Promise<BonjourBackend>;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

/**
 * Start advertising if `def` is non-null. On failure:
 *   - `required: true`  → throw (caller exits non-zero; never pretends success).
 *   - `required: false` → log a warning and return null (best-effort; the server
 *     keeps running without discovery).
 */
export async function startBonjourAdvertising(
  opts: StartBonjourOptions,
): Promise<BonjourAdvertiser | null> {
  if (!opts.def) return null;
  const advertiser = new BonjourAdvertiser(
    opts.def,
    opts.backendFactory ?? createDefaultBonjourBackend,
    opts.log ?? ((m) => console.log(m)),
  );
  try {
    await advertiser.start();
    return advertiser;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const base = `[orbitory] bonjour: advertisement failed: ${detail}`;
    if (opts.required) {
      throw new Error(`${base} (ORBITORY_BONJOUR_REQUIRED=true — refusing to start)`);
    }
    (opts.errorLog ?? ((m) => console.warn(m)))(
      `${base} — continuing without discovery (best-effort; set ORBITORY_BONJOUR_REQUIRED=true to fail closed).`,
    );
    return null;
  }
}

/**
 * Fail-closed wiring for the server startup path. `start` (typically
 * `startBonjourAdvertising`) throws ONLY in required mode when advertisement
 * can't start. By the time this runs the HTTP/WS server is already listening, so
 * a thrown error alone is NOT enough to fail closed — the open socket keeps the
 * event loop (and the fully-serving server) alive while `main().catch` merely
 * sets `process.exitCode`. To honour the documented `ORBITORY_BONJOUR_REQUIRED`
 * guarantee we must explicitly **close the server and exit non-zero**. `closeServer`
 * / `fatalExit` are injected so this is unit-testable without spawning a process
 * or binding a socket.
 */
export async function startAdvertiserWithFailClosed(params: {
  start: () => Promise<BonjourAdvertiser | null>;
  closeServer: () => Promise<void> | void;
  fatalExit: (code: number) => void;
  errorLog?: (msg: string) => void;
}): Promise<BonjourAdvertiser | null> {
  try {
    return await params.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    (params.errorLog ?? ((m) => console.error(m)))(
      `[orbitory] bonjour: required advertisement could not start — closing server and exiting non-zero: ${detail}`,
    );
    await params.closeServer();
    params.fatalExit(1);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default backend (real mDNS). Loaded lazily so nothing binds a socket — and the
// library is not even imported — unless advertisement is actually enabled.
// ---------------------------------------------------------------------------

interface BonjourServiceLib {
  publish(opts: {
    name: string;
    type: string;
    protocol?: "tcp" | "udp";
    port: number;
    txt?: Record<string, string>;
  }): { stop(cb?: () => void): void };
  destroy(): void;
}

interface BonjourServiceModule {
  Bonjour?: new () => BonjourServiceLib;
  default?: { Bonjour?: new () => BonjourServiceLib };
}

/** Split `_orbitory._tcp` → `{ type: "orbitory", protocol: "tcp" }` for bonjour-service. */
export function splitServiceType(serviceType: string): { type: string; protocol: "tcp" | "udp" } {
  const m = /^_([a-z0-9-]+)\._(tcp|udp)$/.exec(serviceType);
  if (m && m[1] && m[2]) return { type: m[1], protocol: m[2] as "tcp" | "udp" };
  // Best-effort fallback for an already-bare type.
  return { type: serviceType.replace(/^_/, "").replace(/\._(tcp|udp)$/, ""), protocol: "tcp" };
}

/** The real backend, backed by the `bonjour-service` npm package (lazy-loaded). */
export function createDefaultBonjourBackend(): BonjourBackend {
  let instance: BonjourServiceLib | null = null;
  return {
    async publish(def: BonjourServiceDefinition): Promise<BonjourPublishHandle> {
      const mod = (await import("bonjour-service")) as unknown as BonjourServiceModule;
      const Ctor = mod.Bonjour ?? mod.default?.Bonjour;
      if (!Ctor) {
        throw new Error("bonjour-service did not export a Bonjour constructor");
      }
      instance = new Ctor();
      const { type, protocol } = splitServiceType(def.serviceType);
      const service = instance.publish({
        name: def.name,
        type,
        protocol,
        port: def.port,
        txt: def.txt,
      });
      return {
        stop: () =>
          new Promise<void>((resolve) => {
            service.stop(() => resolve());
          }),
      };
    },
    shutdown(): void {
      instance?.destroy();
      instance = null;
    },
  };
}
