# Orbitory Host Setup

## 1. Start the Host

```bash
npx orbitory-host@latest
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

The code expires. If pairing fails because it is expired, restart the host command and scan the new code.

## 3. Configure Real Agents

The public package starts in a tester-friendly demo mode. Real Claude Code and Codex providers require a host-local `orbitory.config.json`; the phone cannot create or edit provider config.

Start with the example file only on your host computer:

```bash
cp orbitory.config.example.json orbitory.config.json
```

Keep real CLI use to disposable projects until you have reviewed the sandbox and provider settings.

## 4. Stop the Host

Press `Ctrl-C` in the terminal. The host-agent will close the server and withdraw any local discovery advertisement if enabled.

## Troubleshooting

- Phone cannot connect: set `ORBITORY_ADVERTISED_HOST` to your computer's LAN IP, not `127.0.0.1`.
- QR expired: restart the host command and scan the new code.
- Token warning appears: set `ORBITORY_PAIRING_TOKEN` to a random value for anything beyond quick local testing.
- Real providers missing: confirm the provider is `enabled: true` in host-local config and not rejected by sandbox/config validation.
