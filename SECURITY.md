# Security

Orbitory Host is designed as a local-first monitor/controller for AI coding agents. It is not a hosted execution service and should not be exposed to the public internet.

## Core Rules

- The iOS app never sends arbitrary commands, args, environment variables, images, working directories, or sandbox settings.
- Real providers are configured only on the host computer through `orbitory.config.json`.
- The iOS app can start only host-enabled provider IDs.
- Pairing codes and QR blocks are secrets while valid.
- Provider descriptors returned to clients are sanitized metadata only.
- Process output that reaches clients is scrubbed best-effort; do not treat scrubbing as a guarantee.
- Audit events copy only named safe fields and intentionally omit secrets, raw output, commands, env values, and host paths.

## Pairing Tokens

Set a unique token for any non-trivial local test:

```bash
export ORBITORY_PAIRING_TOKEN="$(openssl rand -hex 24)"
```

If unset, the host-agent falls back to a well-known development token and prints a warning. Never rely on that fallback outside local development.

## Local Network Exposure

The default transport is plaintext HTTP/WebSocket on the local network. Anyone who can observe local traffic may see session data and tokens unless TLS/WSS is enabled. Keep the host-agent on trusted networks and avoid port-forwarding it.

## Test TLS Fixture

This source distribution includes `tests/fixtures/tls/test-cert.pem` and `tests/fixtures/tls/test-key.pem` for deterministic HTTPS/WSS integration tests. They are self-signed, test-only fixtures with zero security value. Never use them for a real host or demo; generate local development certs with `npm run tls:generate`, which writes into the gitignored `.orbitory/certs/` directory.

## Real Claude Code / Codex Use

The real CLI adapters are alpha and should be used only with disposable projects. Automated tests use fake CLIs and do not run real Claude Code or Codex against credential-bearing workspaces.

## Reporting

For private security reports, contact the repository owner through the approved project channel. Do not include full pairing tokens, private keys, provider config, or source-project secrets in reports.
