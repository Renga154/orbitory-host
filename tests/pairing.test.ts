/**
 * Phase 7 — pairing payload + QR-friendly URL tests (pure, no server).
 *
 * The security-critical assertion is that a pairing payload contains ONLY
 * connection details + the token — never command/args/env/image/workingDirectory
 * or any provider config. Plus base64url round-tripping and the full set of
 * decode-rejection cases (mirroring the iOS parser).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  buildPairingPayload,
  decodePairingURL,
  encodePairingURL,
  fromBase64Url,
  PAIRING_PAYLOAD_VERSION,
  resolveAdvertisedHost,
  toBase64Url,
} from "../src/pairing.js";

function samplePayload() {
  return buildPairingPayload({
    port: 4000,
    token: "orbitory-test-token",
    issuedAt: "2026-07-04T00:00:00.000Z",
    host: "192.168.1.10",
    hostName: "test-host",
  });
}

describe("pairing: base64url", () => {
  test("round-trips arbitrary JSON and uses url-safe chars only", () => {
    const original = JSON.stringify({ a: "sk-ant/+=weird", b: [1, 2, 3] });
    const encoded = toBase64Url(original);
    assert.equal(/[+/=]/.test(encoded), false, "base64url must not contain + / or = padding");
    assert.equal(fromBase64Url(encoded), original);
  });
});

describe("pairing: buildPairingPayload", () => {
  test("includes version, product, urls, and the token", () => {
    const p = samplePayload();
    assert.equal(p.version, PAIRING_PAYLOAD_VERSION);
    assert.equal(p.product, "Orbitory");
    assert.equal(p.httpUrl, "http://192.168.1.10:4000");
    assert.equal(p.wsUrl, "ws://192.168.1.10:4000/ws");
    assert.equal(p.token, "orbitory-test-token");
    assert.equal(p.hostName, "test-host");
    assert.equal(p.expiresAt, null);
  });

  test("contains ONLY connection details + token — no provider/execution fields", () => {
    const p = samplePayload() as unknown as Record<string, unknown>;
    const allowed = new Set([
      "version",
      "product",
      "hostId",
      "hostName",
      "httpUrl",
      "wsUrl",
      "httpsUrl",
      "wssUrl",
      "token",
      "issuedAt",
      "expiresAt",
      "transportSecurity",
    ]);
    for (const key of Object.keys(p)) {
      assert.ok(allowed.has(key), `pairing payload has an unexpected key "${key}"`);
    }
    for (const forbidden of ["command", "args", "env", "envAllowlist", "image", "workingDirectory", "sandbox", "providers"]) {
      assert.equal(forbidden in p, false, `pairing payload must never contain "${forbidden}"`);
    }
    // And no forbidden substring smuggled into a key.
    const serialized = JSON.stringify(p).toLowerCase();
    // token is expected; assert none of the execution-config field NAMES appear as keys.
    for (const key of Object.keys(p)) {
      for (const forbidden of ["command", "args", "image", "workingdirectory", "envallowlist"]) {
        assert.equal(key.toLowerCase().includes(forbidden), false);
      }
    }
    void serialized;
  });
});

describe("pairing: encode/decode round-trip", () => {
  test("a built payload survives encode → decode unchanged", () => {
    const p = samplePayload();
    const url = encodePairingURL(p);
    assert.ok(url.startsWith("orbitory://pair?payload="));
    assert.equal(/\s/.test(url), false, "pairing URL must be a single line (QR-friendly)");
    const decoded = decodePairingURL(url);
    assert.deepEqual(decoded, p);
  });
});

describe("pairing: decode rejections (mirrors the iOS parser)", () => {
  const good = encodePairingURL(samplePayload());
  const encodedPayload = new URL(good).searchParams.get("payload")!;

  test("rejects a wrong scheme / host", () => {
    assert.equal(decodePairingURL(`https://pair?payload=${encodedPayload}`), null);
    assert.equal(decodePairingURL(`orbitory://connect?payload=${encodedPayload}`), null);
  });

  test("rejects a missing/empty payload param", () => {
    assert.equal(decodePairingURL("orbitory://pair"), null);
    assert.equal(decodePairingURL("orbitory://pair?payload="), null);
  });

  test("rejects malformed base64 / non-JSON", () => {
    assert.equal(decodePairingURL("orbitory://pair?payload=!!!not-base64!!!"), null);
    assert.equal(decodePairingURL(`orbitory://pair?payload=${toBase64Url("not json")}`), null);
  });

  test("rejects an unsupported version or wrong product", () => {
    const badVersion = toBase64Url(JSON.stringify({ ...samplePayload(), version: 99 }));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${badVersion}`), null);
    const badProduct = toBase64Url(JSON.stringify({ ...samplePayload(), product: "NotOrbitory" }));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${badProduct}`), null);
  });

  test("rejects a missing/empty token or missing url", () => {
    const noToken = toBase64Url(JSON.stringify({ ...samplePayload(), token: "" }));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${noToken}`), null);
    const { wsUrl: _drop, ...withoutWs } = samplePayload();
    const noWs = toBase64Url(JSON.stringify(withoutWs));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${noWs}`), null);
  });
});

describe("pairing: TLS transport (Phase 9)", () => {
  function tlsPayload() {
    return buildPairingPayload({
      port: 4000,
      token: "orbitory-test-token",
      issuedAt: "2026-07-04T00:00:00.000Z",
      host: "192.168.1.10",
      hostName: "test-host",
      expiresAt: "2026-07-04T00:10:00.000Z",
      secure: {
        httpsPort: 4443,
        fingerprintSha256: "a".repeat(64),
        subject: "CN=orbitory-local",
        certExpiresAt: "2027-07-04T00:00:00.000Z",
      },
    });
  }

  test("a TLS payload carries secure URLs + fingerprint and null plaintext URLs", () => {
    const p = tlsPayload();
    assert.equal(p.httpUrl, null);
    assert.equal(p.wsUrl, null);
    assert.equal(p.httpsUrl, "https://192.168.1.10:4443");
    assert.equal(p.wssUrl, "wss://192.168.1.10:4443/ws");
    assert.equal(p.transportSecurity?.mode, "tls");
    assert.equal(p.transportSecurity?.certificateFingerprintSha256, "a".repeat(64));
    assert.equal(p.transportSecurity?.certificateSubject, "CN=orbitory-local");
  });

  test("a TLS payload still contains ONLY allowed keys (no execution fields)", () => {
    const p = tlsPayload() as unknown as Record<string, unknown>;
    for (const forbidden of ["command", "args", "env", "image", "workingDirectory", "sandbox", "providers"]) {
      assert.equal(forbidden in p, false);
    }
    // transportSecurity carries no execution fields either.
    const ts = p["transportSecurity"] as Record<string, unknown>;
    for (const k of Object.keys(ts)) {
      assert.ok(
        ["mode", "certificateFingerprintSha256", "certificateSubject", "expiresAt"].includes(k),
        `transportSecurity has an unexpected key "${k}"`,
      );
    }
  });

  test("a TLS payload survives encode → decode unchanged", () => {
    const p = tlsPayload();
    const decoded = decodePairingURL(encodePairingURL(p));
    assert.deepEqual(decoded, p);
  });

  test("rejects a tls transportSecurity with a missing/malformed fingerprint", () => {
    const base = tlsPayload();
    const noFp = toBase64Url(
      JSON.stringify({ ...base, transportSecurity: { ...base.transportSecurity, certificateFingerprintSha256: null } }),
    );
    assert.equal(decodePairingURL(`orbitory://pair?payload=${noFp}`), null);
    const badFp = toBase64Url(
      JSON.stringify({ ...base, transportSecurity: { ...base.transportSecurity, certificateFingerprintSha256: "xyz" } }),
    );
    assert.equal(decodePairingURL(`orbitory://pair?payload=${badFp}`), null);
  });

  test("rejects an unsupported transportSecurity mode", () => {
    const base = tlsPayload();
    const badMode = toBase64Url(
      JSON.stringify({ ...base, transportSecurity: { ...base.transportSecurity, mode: "quantum" } }),
    );
    assert.equal(decodePairingURL(`orbitory://pair?payload=${badMode}`), null);
  });

  test("rejects a payload with neither a plaintext nor a secure connection pair", () => {
    const base = tlsPayload();
    const noPairs = toBase64Url(
      JSON.stringify({ ...base, httpsUrl: null, wssUrl: null, httpUrl: null, wsUrl: null }),
    );
    assert.equal(decodePairingURL(`orbitory://pair?payload=${noPairs}`), null);
  });

  test("rejects a secure-URL-only code with no transportSecurity (no pinning metadata → fail closed)", () => {
    // Secure URLs present but transportSecurity dropped — must NOT decode as a
    // plaintext-ish code; mirror iOS, which rejects the identical payload.
    const base = tlsPayload();
    const { transportSecurity: _drop, ...withoutTs } = base;
    const stripped = toBase64Url(JSON.stringify(withoutTs));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${stripped}`), null);
    // Also explicit null.
    const explicitNull = toBase64Url(JSON.stringify({ ...base, transportSecurity: null }));
    assert.equal(decodePairingURL(`orbitory://pair?payload=${explicitNull}`), null);
  });
});

/**
 * Boots the real host-agent (`src/index.ts` via tsx) with the given env for a
 * moment, captures stdout+stderr, then kills it. Used to prove the pairing-code
 * print is OFF by default and only appears with the opt-in flag.
 */
function bootAndCaptureOutput(extraEnv: Record<string, string>): Promise<string> {
  // Isolate the per-device store to a throwaway temp file: the Phase 8 startup
  // print issues a real device token, so we must not write into the repo's
  // default `.orbitory/` path.
  const devicesPath = join(tmpdir(), `orbitory-print-test-${randomBytes(6).toString("hex")}.json`);
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORBITORY_PAIRING_TOKEN: "pairing-print-test-token",
        ORBITORY_PAIRED_DEVICES_PATH: devicesPath,
        PORT: "4599",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      if (existsSync(devicesPath)) rmSync(devicesPath);
      resolve(out);
    }, 3000);
  });
}

describe("pairing: startup print is opt-in", () => {
  test("no pairing code is printed by default", async () => {
    const out = await bootAndCaptureOutput({});
    assert.equal(out.includes("orbitory://pair"), false, "pairing code must NOT print without the opt-in flag");
    // The raw token must never appear in normal startup output.
    assert.equal(out.includes("pairing-print-test-token"), false, "raw token must never appear in startup output");
  });

  test("with ORBITORY_PRINT_PAIRING_CODE=true it prints the code behind a warning", async () => {
    const out = await bootAndCaptureOutput({ ORBITORY_PRINT_PAIRING_CODE: "true" });
    assert.match(out, /orbitory:\/\/pair\?payload=/, "opt-in run must print the pairing URL");
    assert.match(out, /Anyone who can see this pairing code can connect/, "must print the sensitivity warning");
    // The static token is embedded nowhere here (the printed code carries a
    // fresh per-device token), and no raw token appears in plaintext regardless.
    assert.equal(out.includes("pairing-print-test-token"), false, "raw token must never appear in plaintext");
  });
});

describe("pairing: expiration (Phase 8)", () => {
  test("buildPairingPayload carries a provided expiresAt, null by default", () => {
    const withExp = buildPairingPayload({
      port: 4000,
      token: "t",
      issuedAt: "2026-07-04T00:00:00.000Z",
      host: "h",
      expiresAt: "2026-07-04T00:10:00.000Z",
    });
    assert.equal(withExp.expiresAt, "2026-07-04T00:10:00.000Z");
    const noExp = buildPairingPayload({
      port: 4000,
      token: "t",
      issuedAt: "2026-07-04T00:00:00.000Z",
      host: "h",
    });
    assert.equal(noExp.expiresAt, null);
  });

  test("a printed pairing code embeds a future expiresAt (server-side expiry)", async () => {
    const out = await bootAndCaptureOutput({
      ORBITORY_PRINT_PAIRING_CODE: "true",
      ORBITORY_PAIRING_TTL_SECONDS: "600",
    });
    const match = out.match(/orbitory:\/\/pair\?payload=\S+/);
    assert.ok(match, "expected a pairing URL in the output");
    const payload = decodePairingURL(match![0]);
    assert.ok(payload, "printed pairing URL should decode");
    assert.ok(payload!.expiresAt, "an issued code must carry an expiresAt");
    assert.ok(
      Date.parse(payload!.expiresAt!) > Date.parse(payload!.issuedAt),
      "expiresAt must be after issuedAt",
    );
  });
});

describe("pairing: resolveAdvertisedHost", () => {
  test("an explicit override wins and is not a loopback fallback", () => {
    assert.deepEqual(resolveAdvertisedHost("10.0.0.5"), { host: "10.0.0.5", isLoopbackFallback: false });
    assert.deepEqual(resolveAdvertisedHost("  10.0.0.6  "), { host: "10.0.0.6", isLoopbackFallback: false });
  });

  test("returns a host either way (real interface or 127.0.0.1 fallback)", () => {
    const r = resolveAdvertisedHost(undefined);
    assert.ok(typeof r.host === "string" && r.host.length > 0);
    // If it fell back to loopback, the flag must say so.
    if (r.host === "127.0.0.1") {
      assert.equal(r.isLoopbackFallback, true);
    }
  });
});

describe("terminal QR rendering (Phase 15.1)", () => {
  // The iOS setup guide promises "a QR code will appear in the terminal".
  // This guards the rendering dependency the print path lazily imports —
  // if it disappears or stops producing output, the guided flow dead-ends.
  test("qrcode-terminal renders a multi-line block for a pairing-style URL", async () => {
    type QrTerminal = { generate: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void };
    const mod = (await import("qrcode-terminal")) as unknown as { default?: QrTerminal } & QrTerminal;
    // Must be called as a method — generate() reads its error level off `this`.
    const qrterminal = mod.default ?? mod;
    assert.equal(typeof qrterminal.generate, "function", "qrcode-terminal must expose generate()");
    const qr = await new Promise<string>((resolve) => {
      qrterminal.generate("orbitory://pair?payload=dGVzdA", { small: true }, resolve);
    });
    const lines = qr.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 10, `QR block should be multi-line, got ${lines.length}`);
    assert.match(qr, /[█▀▄]/, "QR block should contain block-drawing characters");
  });
});
