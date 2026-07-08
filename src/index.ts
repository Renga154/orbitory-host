/**
 * Orbitory host-agent entry point.
 *
 * Builds the Fastify application (see `server.ts`) and starts it listening
 * on `PORT`, bound to all interfaces so it's reachable from other devices on
 * the local network (e.g. a phone running the Orbitory client). On success,
 * prints a startup banner with the health-check and WebSocket URLs; if the
 * pairing token is still the well-known development fallback, repeats the
 * loud warning here too so it's impossible to miss right when the server
 * comes up.
 */

import {
  BONJOUR_ENABLED,
  BONJOUR_NAME,
  BONJOUR_PORT,
  BONJOUR_REQUIRED,
  BONJOUR_SERVICE_TYPE,
  DEV_FALLBACK_PAIRING_TOKEN,
  HTTPS_PORT,
  NODE_ENV,
  PAIRING_TOKEN,
  PORT,
  TLS_CERT_PATH,
  TLS_ENABLED,
  TLS_HOSTNAME,
  TLS_KEY_PATH,
} from "./config.js";
import { setInternalApprovalBaseUrl } from "./approvalBridge.js";
import {
  buildBonjourAdvertisement,
  resolveBonjourNames,
  startAdvertiserWithFailClosed,
  startBonjourAdvertising,
  type BonjourAdvertiser,
} from "./bonjour.js";
import { redactToken } from "./logging.js";
import { issuePairingCode } from "./pairingIssue.js";
import { buildServer } from "./server.js";
import { loadTlsMaterials, type TlsMaterials } from "./tls.js";
import { SERVER_VERSION } from "./ws.js";

function printDevPairingTokenReminder(): void {
  const banner = [
    "",
    "############################################################",
    "#                                                          #",
    "#   WARNING: ORBITORY_PAIRING_TOKEN IS NOT SET             #",
    "#                                                          #",
    "#   The host-agent is running with the well-known          #",
    `#   development token: "${DEV_FALLBACK_PAIRING_TOKEN}"${" ".repeat(
      Math.max(0, 24 - DEV_FALLBACK_PAIRING_TOKEN.length),
    )}#`,
    "#                                                          #",
    "#   This token is PUBLIC and offers NO real security.      #",
    "#   NEVER expose this server to the public internet        #",
    "#   while relying on this fallback token.                  #",
    "#                                                          #",
    "############################################################",
    "",
  ].join("\n");

  console.warn(banner);
}

async function main(): Promise<void> {
  // Phase 9: load TLS material up front. If TLS is required but the cert/key are
  // missing/invalid, loadTlsMaterials throws a clear error — main().catch exits
  // non-zero rather than ever downgrading to plaintext.
  const tls: TlsMaterials | null = TLS_ENABLED
    ? loadTlsMaterials({ certPath: TLS_CERT_PATH, keyPath: TLS_KEY_PATH })
    : null;

  const app = tls
    ? await buildServer({ tls: { cert: tls.cert, key: tls.key } })
    : await buildServer();

  const scheme = tls ? "https" : "http";
  const wsScheme = tls ? "wss" : "ws";
  const listenPort = tls ? HTTPS_PORT : PORT;

  await app.listen({ port: listenPort, host: "0.0.0.0" });

  // Phase 16: tell the approval bridge where /internal/approvals is actually
  // reachable on loopback (the bound port is only known after listen()).
  setInternalApprovalBaseUrl(`${scheme}://127.0.0.1:${listenPort}`);

  console.log(
    [
      "",
      "============================================================",
      " Orbitory host-agent is up",
      "============================================================",
      ` NODE_ENV:      ${NODE_ENV}`,
      ` Transport:     ${tls ? "TLS (HTTPS/WSS)" : "plaintext (HTTP/WS)"}`,
      ` Port:          ${listenPort}`,
      ` Pairing token: ${redactToken(PAIRING_TOKEN)}`,
      ` Health check:  ${scheme}://localhost:${listenPort}/health`,
      ` WebSocket:     ${wsScheme}://localhost:${listenPort}/ws`,
      ...(tls
        ? [
            ` TLS subject:   ${tls.subject}`,
            ` TLS fp(sha256):${tls.fingerprintSha256}`,
            ` TLS notAfter:  ${tls.expiresAt}`,
          ]
        : [
            " NOTE: plaintext transport — pairing token and session data are",
            "       visible on the local network. Set ORBITORY_TLS_ENABLED=true",
            "       (see docs/PHASE9_TLS_WSS_LOCAL_TRANSPORT.md) to serve HTTPS/WSS.",
          ]),
      "============================================================",
      "",
    ].join("\n"),
  );

  if (PAIRING_TOKEN === DEV_FALLBACK_PAIRING_TOKEN) {
    printDevPairingTokenReminder();
  }

  await maybePrintPairingCode(tls);

  // Phase 13: opt-in Bonjour/mDNS advertisement. Disabled unless
  // ORBITORY_BONJOUR_ENABLED=true. Advertises SAFE metadata only (never a token,
  // provider config, command, or path); discovery is not authentication and
  // pairing is still required. See docs/PHASE13_BONJOUR_HOST_DISCOVERY.md.
  // Fail-closed for ORBITORY_BONJOUR_REQUIRED=true: because the server is already
  // listening here, a thrown error alone would keep the process serving. Close the
  // server and exit non-zero explicitly (best-effort mode never throws — it returns
  // null and the server keeps running without discovery).
  const advertiser = await startAdvertiserWithFailClosed({
    start: () => startBonjourAdvertisement(Boolean(tls), listenPort),
    closeServer: () => app.close(),
    fatalExit: (code) => process.exit(code),
  });
  registerShutdownHandlers(app, advertiser);
}

/** Resolve the Bonjour advertisement from config + transport, then start it (opt-in). */
async function startBonjourAdvertisement(
  tls: boolean,
  listenPort: number,
): Promise<BonjourAdvertiser | null> {
  if (!BONJOUR_ENABLED) return null;
  const { hostId, serviceName } = resolveBonjourNames({ bonjourName: BONJOUR_NAME });
  const advertisedPort = BONJOUR_PORT ?? listenPort;
  const def = buildBonjourAdvertisement({
    serviceName,
    serviceType: BONJOUR_SERVICE_TYPE,
    port: advertisedPort,
    hostId,
    hostName: serviceName,
    tls,
    httpPort: tls ? undefined : advertisedPort,
    httpsPort: tls ? advertisedPort : undefined,
    wsPath: "/ws",
    version: SERVER_VERSION,
  });
  return startBonjourAdvertising({ def, required: BONJOUR_REQUIRED });
}

/**
 * Stop the Bonjour advertisement and close the server on SIGINT/SIGTERM so a
 * Ctrl-C'd host-agent withdraws its mDNS record instead of leaving a stale one.
 */
function registerShutdownHandlers(
  app: Awaited<ReturnType<typeof buildServer>>,
  advertiser: BonjourAdvertiser | null,
): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[orbitory-host-agent] Received ${signal}; shutting down…`);
    try {
      await advertiser?.stop();
    } catch {
      /* best-effort — never block shutdown on withdrawing an mDNS record */
    }
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Phase 7/8: print a QR-friendly `orbitory://pair?payload=…` pairing code, but
 * ONLY when explicitly opted in via `ORBITORY_PRINT_PAIRING_CODE=true`. As of
 * Phase 8 this issues a fresh, expiring **per-device token** (registered hashed
 * in the store — see `pairingIssue.ts`), so the code embeds a token that expires
 * server-side. Printed behind a loud warning, never by default. It is a one-off
 * startup console line (custom scheme, not an HTTP URL), so it never enters the
 * Fastify request logs. See docs/PHASE8_QR_PAIRING_HARDENING.md.
 *
 * Phase 15.1: the same opt-in also renders the code as a terminal QR block so
 * the iOS setup guide's "scan the QR code in your terminal" step is actually
 * true. The QR encodes exactly `issued.url` — the same already-gated,
 * connection-details-only payload; no new data, same warning, same flag.
 * Best-effort: if rendering fails the plain URL + paste flow still work.
 */
async function maybePrintPairingCode(tls: TlsMaterials | null): Promise<void> {
  if (process.env["ORBITORY_PRINT_PAIRING_CODE"] !== "true") {
    return;
  }
  const issued = issuePairingCode({
    deviceName: "Orbitory iOS (startup)",
    issuedAt: new Date().toISOString(),
    // Phase 9: advertise secure URLs + the cert fingerprint the phone will pin.
    secureTransport: tls
      ? {
          fingerprintSha256: tls.fingerprintSha256,
          subject: tls.subject,
          certExpiresAt: tls.expiresAt,
          httpsPort: HTTPS_PORT,
          hostname: TLS_HOSTNAME,
        }
      : undefined,
  });

  const qrBlock = await renderTerminalQr(issued.url);

  console.warn(
    [
      "",
      "------------------------------------------------------------",
      " ORBITORY PAIRING CODE (sensitive — contains a device token)",
      "------------------------------------------------------------",
      " Anyone who can see this pairing code can connect to this",
      " host-agent until it expires. Do not share it, screenshot it",
      " into a chat, or display it where others can photograph it.",
      "",
      ` ${issued.url}`,
      "",
      ...(qrBlock
        ? [qrBlock]
        : [" (QR rendering unavailable — copy the URL above and use", "  Paste Pairing Code in the app instead.)", ""]),
      issued.expiresAt
        ? ` Expires: ${issued.expiresAt}  (device ${issued.deviceId})`
        : ` No expiry (TTL disabled — dev only). Device ${issued.deviceId}.`,
      tls
        ? ` Transport: TLS/WSS — the app pins cert fp(sha256) ${tls.fingerprintSha256}`
        : " Transport: plaintext WS (not encrypted — enable ORBITORY_TLS_ENABLED for WSS).",
      " Scan it in the Orbitory iOS app (Settings > Connection",
      " Profiles > Scan QR Code), or paste it via Paste Pairing Code.",
      issued.isLoopbackFallback
        ? " NOTE: advertised host is 127.0.0.1 (localhost only). Set\n ORBITORY_ADVERTISED_HOST=<LAN-IP> so a phone can reach it."
        : ` Advertised host: ${issued.host}`,
      "------------------------------------------------------------",
      "",
    ].join("\n"),
  );
}

/**
 * Renders `text` as a compact terminal QR block. Lazily imports
 * `qrcode-terminal` (same pattern as the Bonjour backend) and returns null on
 * any failure so the pairing print path never breaks over a rendering module.
 */
async function renderTerminalQr(text: string): Promise<string | null> {
  try {
    type QrTerminal = { generate: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void };
    const mod = (await import("qrcode-terminal")) as unknown as { default?: QrTerminal } & QrTerminal;
    // Call generate as a METHOD — it reads the error level off `this`;
    // a detached function reference throws "bad rs block ... undefined".
    const qrterminal = mod.default ?? mod;
    if (typeof qrterminal.generate !== "function") {
      return null;
    }
    return await new Promise<string | null>((resolve) => {
      qrterminal.generate(text, { small: true }, (qr) => resolve(qr));
    });
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error("[orbitory-host-agent] Fatal error during startup:", err);
  process.exitCode = 1;
});
