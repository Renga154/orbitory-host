/**
 * Phase 13 — Bonjour / mDNS host-discovery advertisement tests (pure, no real mDNS).
 *
 * The security-critical assertion is that the advertised TXT record contains
 * ONLY safe metadata — never a token, provider config, command, path, or secret.
 * Lifecycle (start/stop, graceful failure, fail-closed `required`) is exercised
 * against an INJECTED fake backend, so `npm test` never binds an mDNS socket or
 * needs the network.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BONJOUR_DEFAULT_SERVICE_TYPE,
  BonjourAdvertiser,
  buildBonjourAdvertisement,
  isValidBonjourServiceType,
  normalizeBonjourServiceType,
  parseBonjourPort,
  resolveBonjourNames,
  splitServiceType,
  startAdvertiserWithFailClosed,
  startBonjourAdvertising,
  type BonjourAdvertisementInput,
  type BonjourBackend,
  type BonjourServiceDefinition,
} from "../src/bonjour.js";
import {
  BONJOUR_ENABLED,
  BONJOUR_NAME,
  BONJOUR_PORT,
  BONJOUR_REQUIRED,
  BONJOUR_SERVICE_TYPE,
} from "../src/config.js";

// The complete set of TXT keys the advertisement is ever allowed to carry.
const ALLOWED_TXT_KEYS = new Set([
  "product",
  "txtvers",
  "version",
  "hostid",
  "hostname",
  "tls",
  "wspath",
  "pairing",
  "httpport",
  "httpsport",
]);

// Substrings that must NEVER appear as a TXT key (execution/secret fields).
const FORBIDDEN_TXT_KEY_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "credential",
  "command",
  "args",
  "workingdirectory",
  "sandbox",
  "image",
  "apikey",
  "privatekey",
  "authorization",
  "certkey",
];

function plaintextInput(overrides: Partial<BonjourAdvertisementInput> = {}): BonjourAdvertisementInput {
  return {
    serviceName: "Renga MacBook Pro",
    serviceType: BONJOUR_DEFAULT_SERVICE_TYPE,
    port: 4000,
    hostId: "renga-mbp.local",
    hostName: "Renga MacBook Pro",
    tls: false,
    httpPort: 4000,
    wsPath: "/ws",
    version: "0.1.0",
    ...overrides,
  };
}

function tlsInput(overrides: Partial<BonjourAdvertisementInput> = {}): BonjourAdvertisementInput {
  return plaintextInput({ tls: true, httpPort: undefined, httpsPort: 4443, port: 4443, ...overrides });
}

// A fake Bonjour backend that records calls without touching the network.
function makeFakeBackend(opts: { failPublish?: boolean } = {}) {
  const state = {
    published: [] as BonjourServiceDefinition[],
    stopped: 0,
    shutdowns: 0,
  };
  const backend: BonjourBackend = {
    publish(def: BonjourServiceDefinition) {
      if (opts.failPublish) throw new Error("fake publish failed");
      state.published.push(def);
      return {
        stop() {
          state.stopped += 1;
        },
      };
    },
    shutdown() {
      state.shutdowns += 1;
    },
  };
  return { backend, state };
}

describe("Bonjour config parsing (service type + port)", () => {
  test("service type: unset falls back to the default, without flagging invalid", () => {
    assert.deepEqual(normalizeBonjourServiceType(undefined), {
      serviceType: BONJOUR_DEFAULT_SERVICE_TYPE,
      wasInvalid: false,
    });
    assert.deepEqual(normalizeBonjourServiceType("   "), {
      serviceType: BONJOUR_DEFAULT_SERVICE_TYPE,
      wasInvalid: false,
    });
  });

  test("service type: a well-formed value is accepted verbatim", () => {
    assert.deepEqual(normalizeBonjourServiceType("_orbitory._tcp"), {
      serviceType: "_orbitory._tcp",
      wasInvalid: false,
    });
    assert.deepEqual(normalizeBonjourServiceType("_my-svc._udp"), {
      serviceType: "_my-svc._udp",
      wasInvalid: false,
    });
  });

  test("service type: a malformed value falls back and is flagged invalid", () => {
    for (const bad of ["orbitory", "_orbitory", "_orbitory._sctp", "_orbitory._tcp extra", "_ORBITORY._tcp"]) {
      const result = normalizeBonjourServiceType(bad);
      assert.equal(result.serviceType, BONJOUR_DEFAULT_SERVICE_TYPE, `"${bad}" should fall back`);
      assert.equal(result.wasInvalid, true, `"${bad}" should be flagged invalid`);
    }
  });

  test("isValidBonjourServiceType matches only well-formed types", () => {
    assert.equal(isValidBonjourServiceType("_orbitory._tcp"), true);
    assert.equal(isValidBonjourServiceType("_x._udp"), true);
    assert.equal(isValidBonjourServiceType("orbitory"), false);
    assert.equal(isValidBonjourServiceType("_orbitory._tcp "), false);
  });

  test("port: unset is undefined; valid parses; invalid is flagged and dropped", () => {
    assert.deepEqual(parseBonjourPort(undefined), { port: undefined, wasInvalid: false });
    assert.deepEqual(parseBonjourPort(""), { port: undefined, wasInvalid: false });
    assert.deepEqual(parseBonjourPort("4000"), { port: 4000, wasInvalid: false });
    for (const bad of ["0", "-1", "abc", "40.5", "99999999999999999999"]) {
      const result = parseBonjourPort(bad);
      assert.equal(result.wasInvalid, true, `"${bad}" should be invalid`);
      assert.equal(result.port, undefined, `"${bad}" should not yield a port`);
    }
  });

  test("splitServiceType maps a full type to bonjour-service's { type, protocol }", () => {
    assert.deepEqual(splitServiceType("_orbitory._tcp"), { type: "orbitory", protocol: "tcp" });
    assert.deepEqual(splitServiceType("_my-svc._udp"), { type: "my-svc", protocol: "udp" });
  });

  test("resolveBonjourNames uses the injected hostname and name override", () => {
    assert.deepEqual(resolveBonjourNames({ bonjourName: "Studio", hostname: "host.local" }), {
      hostId: "host.local",
      serviceName: "Studio",
    });
    assert.deepEqual(resolveBonjourNames({ bonjourName: undefined, hostname: "host.local" }), {
      hostId: "host.local",
      serviceName: "host.local",
    });
  });
});

describe("Bonjour is disabled by default", () => {
  test("with no ORBITORY_BONJOUR_* env set, advertisement is off and defaults hold", () => {
    // The test harness sets other ORBITORY_* vars but never ORBITORY_BONJOUR_*,
    // so this pins the opt-in / disabled-by-default posture.
    assert.equal(BONJOUR_ENABLED, false);
    assert.equal(BONJOUR_REQUIRED, false);
    assert.equal(BONJOUR_SERVICE_TYPE, BONJOUR_DEFAULT_SERVICE_TYPE);
    assert.equal(BONJOUR_PORT, undefined);
    assert.equal(BONJOUR_NAME, undefined);
  });
});

describe("buildBonjourAdvertisement — safe TXT only", () => {
  test("plaintext: expected safe fields, httpport present, no httpsport", () => {
    const def = buildBonjourAdvertisement(plaintextInput());
    assert.equal(def.name, "Renga MacBook Pro");
    assert.equal(def.serviceType, "_orbitory._tcp");
    assert.equal(def.port, 4000);
    assert.equal(def.txt.product, "Orbitory");
    assert.equal(def.txt.txtvers, "1");
    assert.equal(def.txt.version, "0.1.0");
    assert.equal(def.txt.hostid, "renga-mbp.local");
    assert.equal(def.txt.hostname, "Renga MacBook Pro");
    assert.equal(def.txt.tls, "false");
    assert.equal(def.txt.wspath, "/ws");
    assert.equal(def.txt.pairing, "required");
    assert.equal(def.txt.httpport, "4000");
    assert.equal(def.txt.httpsport, undefined);
  });

  test("TLS: tls=true, httpsport present, no httpport", () => {
    const def = buildBonjourAdvertisement(tlsInput());
    assert.equal(def.port, 4443);
    assert.equal(def.txt.tls, "true");
    assert.equal(def.txt.httpsport, "4443");
    assert.equal(def.txt.httpport, undefined);
  });

  test("TXT keys are EXACTLY the allowed safe set (no unexpected keys)", () => {
    for (const def of [buildBonjourAdvertisement(plaintextInput()), buildBonjourAdvertisement(tlsInput())]) {
      for (const key of Object.keys(def.txt)) {
        assert.ok(ALLOWED_TXT_KEYS.has(key), `unexpected TXT key "${key}"`);
      }
    }
  });

  test("no TXT key resembles a token / provider-config / secret field", () => {
    for (const def of [buildBonjourAdvertisement(plaintextInput()), buildBonjourAdvertisement(tlsInput())]) {
      for (const key of Object.keys(def.txt)) {
        const lower = key.toLowerCase();
        for (const forbidden of FORBIDDEN_TXT_KEY_SUBSTRINGS) {
          assert.equal(lower.includes(forbidden), false, `TXT key "${key}" must not contain "${forbidden}"`);
        }
      }
    }
  });

  test("no planted secret survives into the advertisement (recursive scan)", () => {
    // Even though the typed builder has no field to smuggle a secret through, we
    // scan the whole emitted definition to lock the invariant: no token/secret/
    // command/private-key material anywhere in the advertised bytes.
    const def = buildBonjourAdvertisement(plaintextInput());
    const serialized = JSON.stringify(def).toLowerCase();
    for (const needle of [
      "orbitory-dev-token",
      "sk-ant-",
      "-----begin",
      "command",
      "args",
      "workingdirectory",
      "sandbox",
      "envallowlist",
      "authorization",
      "bearer ",
    ]) {
      assert.equal(serialized.includes(needle), false, `advertisement must not contain "${needle}"`);
    }
  });
});

describe("BonjourAdvertiser lifecycle (fake backend)", () => {
  test("start() publishes the exact definition once; stop() withdraws + shuts down", async () => {
    const { backend, state } = makeFakeBackend();
    const def = buildBonjourAdvertisement(plaintextInput());
    const advertiser = new BonjourAdvertiser(def, () => backend, () => {});

    await advertiser.start();
    assert.equal(state.published.length, 1);
    assert.deepEqual(state.published[0], def);
    assert.equal(state.stopped, 0);

    await advertiser.stop();
    assert.equal(state.stopped, 1);
    assert.equal(state.shutdowns, 1);
  });
});

describe("startBonjourAdvertising — orchestration + fail modes", () => {
  test("a null definition (disabled) starts nothing and returns null", async () => {
    const { backend, state } = makeFakeBackend();
    const advertiser = await startBonjourAdvertising({
      def: null,
      required: false,
      backendFactory: () => backend,
    });
    assert.equal(advertiser, null);
    assert.equal(state.published.length, 0);
  });

  test("a valid definition starts advertising and returns the advertiser", async () => {
    const { backend, state } = makeFakeBackend();
    const def = buildBonjourAdvertisement(plaintextInput());
    const advertiser = await startBonjourAdvertising({
      def,
      required: false,
      backendFactory: () => backend,
      log: () => {},
    });
    assert.ok(advertiser);
    assert.equal(state.published.length, 1);
  });

  test("best-effort (required=false): a failing backend logs and returns null, never throws", async () => {
    const { backend } = makeFakeBackend({ failPublish: true });
    let errored = "";
    const advertiser = await startBonjourAdvertising({
      def: buildBonjourAdvertisement(plaintextInput()),
      required: false,
      backendFactory: () => backend,
      log: () => {},
      errorLog: (m) => {
        errored = m;
      },
    });
    assert.equal(advertiser, null);
    assert.match(errored, /advertisement failed/i);
  });

  test("fail-closed (required=true): a failing backend rejects (never pretends success)", async () => {
    const { backend } = makeFakeBackend({ failPublish: true });
    await assert.rejects(
      () =>
        startBonjourAdvertising({
          def: buildBonjourAdvertisement(plaintextInput()),
          required: true,
          backendFactory: () => backend,
          log: () => {},
        }),
      /ORBITORY_BONJOUR_REQUIRED=true/,
    );
  });
});

describe("startAdvertiserWithFailClosed — fail-closed wiring (server already listening)", () => {
  const freshDef = () => buildBonjourAdvertisement(plaintextInput());

  test("required-mode failure CLOSES the server and exits non-zero", async () => {
    const { backend } = makeFakeBackend({ failPublish: true });
    let closed = false;
    let exitCode: number | null = null;
    const result = await startAdvertiserWithFailClosed({
      start: () =>
        startBonjourAdvertising({ def: freshDef(), required: true, backendFactory: () => backend, log: () => {} }),
      closeServer: async () => {
        closed = true;
      },
      fatalExit: (code) => {
        exitCode = code;
      },
      errorLog: () => {},
    });
    // The documented ORBITORY_BONJOUR_REQUIRED=true guarantee: don't keep serving.
    assert.equal(closed, true, "server must be closed on required failure");
    assert.equal(exitCode, 1, "must exit non-zero on required failure");
    assert.equal(result, null);
  });

  test("best-effort (not required) failure does NOT close the server or exit", async () => {
    const { backend } = makeFakeBackend({ failPublish: true });
    let closed = false;
    let exited = false;
    const result = await startAdvertiserWithFailClosed({
      start: () =>
        startBonjourAdvertising({
          def: freshDef(),
          required: false,
          backendFactory: () => backend,
          log: () => {},
          errorLog: () => {},
        }),
      closeServer: async () => {
        closed = true;
      },
      fatalExit: () => {
        exited = true;
      },
    });
    assert.equal(closed, false, "server must keep running when advertisement is best-effort");
    assert.equal(exited, false, "must not exit on a best-effort failure");
    assert.equal(result, null);
  });

  test("success returns the advertiser without closing or exiting", async () => {
    const { backend } = makeFakeBackend();
    let closed = false;
    let exited = false;
    const result = await startAdvertiserWithFailClosed({
      start: () =>
        startBonjourAdvertising({ def: freshDef(), required: true, backendFactory: () => backend, log: () => {} }),
      closeServer: async () => {
        closed = true;
      },
      fatalExit: () => {
        exited = true;
      },
    });
    assert.ok(result);
    assert.equal(closed, false);
    assert.equal(exited, false);
  });
});
