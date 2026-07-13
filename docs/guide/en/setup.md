# Orbitory Host Setup

## 1. Start the Host

```bash
npx orbitory-host@latest
```

By default, the iPhone sees only this real computer and no fake demo sessions. Use demo mode only for screenshots or guided exploration:

```bash
npx orbitory-host@latest --demo
```

If your iPhone is on the same Wi-Fi network, advertise your computer's LAN address:

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

Keep the terminal open. The QR code and pairing URL printed there are sensitive.

## 2. Pair the iPhone App

1. Open Orbitory on iPhone.
2. Go to Settings.
3. Open the setup guide.
4. Scan the QR code, or paste the `orbitory://pair?...` URL.

The QR grant expires after 10 minutes by default. The first successful saved-profile connection
promotes it to a sliding 30-day device credential, so ordinary reconnects do not require another
scan. If the initial scan expires, or the app says re-pairing is required, restart the host command
and scan the new code once.

## 3. Configure Real Agents

Real Claude Code and Codex providers require a host-local `orbitory.config.json`; the phone cannot create or edit provider config.

From the project folder you want the AI to work in, run:

```bash
npx orbitory-host@latest --setup
```

Choose Codex or Claude Code. Setup writes or updates `orbitory.config.json` in that folder with the selected provider enabled.
Setup first confirms that the selected CLI is installed and authenticated. It stores the detected executable's absolute path in the host-only config, so later host launches do not depend on nvm or background-process PATH differences. When updating an existing provider, setup verifies and preserves that configured executable instead of replacing it with a different duplicate found earlier on PATH. If the CLI is missing, setup exits without creating an unusable enabled provider and links to the official installer.

For Claude Code, setup also performs one minimal no-tools response in an empty temporary directory, with session persistence disabled. This catches stale credentials where `claude auth status` says logged in but the API returns 401. It sends no project content, but it can consume a very small amount of your Claude allowance.

If the CLI is installed but signed out, setup asks how to authenticate:

- `browser`: opens the provider's official login flow on this computer.
- `phone`: Codex uses its device-code flow, so you can approve on the provider's official page on your phone. Claude Code shows a URL you can open on the phone and a code to return to the terminal.
- `later`: exits without enabling an unusable provider.

Orbitory never receives your password or OAuth token. The official Codex or Claude Code CLI handles authentication directly on the computer. The computer must still run Orbitory Host, but Codex login approval itself can be completed on the phone.

If Orbitory Host is already running, the latest version reloads the corrected config automatically; just tap Refresh in the app. If no host is running, start it from the same folder:

```bash
npx orbitory-host@latest
```

For a non-interactive local retry:

```bash
npx orbitory-host@latest --setup codex --yes
```

`--yes` never opens login unexpectedly. To include an explicit login step in a non-interactive setup, use one of these:

```bash
npx orbitory-host@latest --setup codex --login-device --yes
npx orbitory-host@latest --setup claude --login-browser --yes
```

For Codex, Orbitory runs one public `codex exec --json` turn per instruction and resumes the
host-held thread for the next instruction. Recent projects and existing Codex tasks are optional:

```bash
npx orbitory-host@latest --setup codex --include-codex-projects --yes
```

This opt-in uses Codex's experimental local app-server only for bounded, read-only history listing.
Orbitory gives app-server disposable writable state and does not copy Codex authentication or config
into it. It grants the paired phone broad start/resume access to those projects. Paths, prompt bodies,
and raw Codex thread ids stay on the computer. Revoke it by rerunning
`npx orbitory-host@latest --setup codex --yes` without the history flag (or by disabling
`projectCatalog.codexHistory`).

To let Claude Code start **new** sessions in the same explicitly discovered project folders:

```bash
npx orbitory-host@latest --setup claude --include-recent-projects --yes
```

This adds the Claude provider to the host-local broad-access allowlist. It does not read private
Claude history and cannot resume Claude tasks; Codex remains the source of the sanitized folder
catalog. Rerun Claude setup without `--include-recent-projects` to revoke that access.

Provider management remains local:

```bash
npx orbitory-host@latest --list-providers
npx orbitory-host@latest --remove-provider <provider-id>
```

Advanced/manual path: `npx orbitory-host@latest --init-config` writes a starter config with a demo provider enabled and Claude Code/Codex templates disabled. Keep real CLI use to disposable projects until you have reviewed the sandbox and provider settings.

## 4. Stop the Host

Press `Ctrl-C` in the terminal. The host-agent will close the server and withdraw any local discovery advertisement if enabled.

## Troubleshooting

- Phone cannot connect: set `ORBITORY_ADVERTISED_HOST` to your computer's LAN IP, not `127.0.0.1`.
- QR expired: restart the host command and scan the new code.
- Token warning appears: set `ORBITORY_PAIRING_TOKEN` to a random value for anything beyond quick local testing.
- Provider says Unavailable: rerun `npx orbitory-host@latest --setup` in the project folder, then tap Refresh. The latest host reloads config changes automatically.
- Provider CLI not found: install it from the official URL printed by setup, then rerun the same command. Orbitory does not install or impersonate an AI provider.
- Claude says logged in but a session reports authentication failure: the local credential is stale. Run `claude auth login`, approve the official Claude page, then rerun `npx orbitory-host@latest --setup claude --yes`.
- Multiple `claude` installations exist: rerun setup in the same project folder. Orbitory preserves the absolute executable already pinned in that folder's provider config; remove or reorder stale duplicates separately if desired.
- `EADDRINUSE ... 0.0.0.0:4000`: this is not an AI login failure. Another process already owns port 4000. If it is an Orbitory host, do not start a second copy; tap Refresh. If it is an older host, stop its terminal with `Ctrl-C`, then rerun `npx orbitory-host@latest`.
- nvm warns about `.npmrc` `prefix/globalconfig`: this is a Node.js environment warning, separate from Orbitory's provider config. If the command continues, setup can still succeed. If needed, run the `nvm use --delete-prefix <version> --silent` command shown in the warning.
