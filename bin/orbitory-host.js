#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = resolve(root, "dist/index.js");
const extra = process.argv.slice(2);

if (extra.includes("--help") || extra.includes("-h")) {
  console.log(
    [
      "Usage: orbitory-host",
      "",
      "Starts the local Orbitory host-agent and prints a sensitive pairing QR/code.",
      "",
      "Common environment variables:",
      "  PORT=4000",
      "  ORBITORY_ADVERTISED_HOST=192.168.1.10",
      "  ORBITORY_PAIRING_TOKEN=<random-secret>",
      "  ORBITORY_TLS_ENABLED=true",
      "  ORBITORY_TLS_CERT_PATH=/path/to/cert.pem",
      "  ORBITORY_TLS_KEY_PATH=/path/to/key.pem",
      "",
      "Publishing, public repo pushes, and npm publish remain manual approval gates.",
    ].join("\n"),
  );
  process.exit(0);
}

if (extra.length > 0) {
  console.error(`[orbitory-host] Unknown option: ${extra[0]}`);
  console.error("Run `orbitory-host --help` for supported configuration.");
  process.exit(1);
}

if (!existsSync(entrypoint)) {
  console.error(
    [
      "[orbitory-host] Built files are missing.",
      "Run `npm run build` in the package source, or reinstall the published package.",
    ].join("\n"),
  );
  process.exit(1);
}

process.env.ORBITORY_PRINT_PAIRING_CODE ??= "true";
process.env.ORBITORY_DEMO_SESSIONS ??= "true";

await import(pathToFileURL(entrypoint).href);
