# Orbitory Host

Orbitory Host is the local computer-side agent for Orbitory, an iPhone workroom for AI coding agents. It runs on your Mac or Linux machine, exposes a local HTTP/WebSocket endpoint, and prints a pairing code the iOS app can scan.

This package is early alpha software. It is local-first supervision tooling, not a remote desktop, not a mobile IDE, and not a hosted execution service.

## Quick Start

```bash
npx orbitory-host@latest
```

The command starts the host-agent and prints a sensitive `orbitory://pair?...` code plus a terminal QR block. In the Orbitory iOS app, open Settings, start the setup guide, and scan that QR code.

For a phone on the same Wi-Fi network, set the advertised host to your computer's LAN address:

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

## What Starts by Default

- HTTP/WebSocket on port `4000`.
- A pairing QR/code printed at startup.
- One real local computer row and no fake demo sessions. Use `--demo` only when you want screenshot/demo data.
- A development fallback pairing token if `ORBITORY_PAIRING_TOKEN` is unset. The server prints a loud warning for this; set a real token before exposing the host beyond local testing.

For demo/screenshot mode:

```bash
npx orbitory-host@latest --demo
```

## Safer Local Run

```bash
export ORBITORY_PAIRING_TOKEN="$(openssl rand -hex 24)"
export ORBITORY_ADVERTISED_HOST="192.168.1.10"
npx orbitory-host@latest
```

The pairing code still contains a device token until it expires. Treat the terminal QR/code like a password.

## Real Agent Configuration

Real Claude Code and Codex adapters are alpha and host-configured. The phone can start only enabled provider IDs from your local config; it never sends commands, args, env, images, working directories, or sandbox settings.

From the project folder you want the AI to work in, run the guided setup:

```bash
npx orbitory-host@latest --setup
```

Choose Codex or Claude Code when prompted. Setup verifies that the CLI exists, pins its detected absolute path in the host-only config, and checks login before enabling it. If the CLI is signed out, choose browser login or phone login. Orbitory delegates authentication to the provider's official CLI and never receives your password or OAuth token. Codex phone login uses its official device-code flow; Claude Code can show a URL and return code for a phone browser.

Orbitory writes or updates the host-local `orbitory.config.json` with that provider enabled for the current folder. A host already running the latest package reloads the config automatically, so tap Refresh in Orbitory instead of starting a second copy. If no host is running, start `npx orbitory-host@latest` from the same folder. For scripts or a fast local retry:

```bash
npx orbitory-host@latest --setup codex --yes
```

To explicitly include authentication in a scripted setup:

```bash
npx orbitory-host@latest --setup codex --login-device --yes
npx orbitory-host@latest --setup claude --login-browser --yes
```

Advanced/manual path: `npx orbitory-host@latest --init-config` still writes a starter config with a safe demo provider enabled and Claude Code/Codex templates disabled. Keep real credential-bearing projects disposable until you have reviewed the config, sandbox, and security notes. Tests use fake CLIs only.

## TLS

Plaintext local WebSocket is the default for development. For local TLS/WSS:

```bash
npx orbitory-host@latest --help
```

Package-level TLS helper scripts are included for source installs; published package usage will document the stable TLS path as it hardens.

## 日本語クイックスタート

```bash
npx orbitory-host@latest
```

起動すると、ターミナルに `orbitory://pair?...` のペアリングコードとQRが表示されます。iOS版 Orbitory の Settings からセットアップガイドを開き、QRコードを読み取ってください。

iPhoneと同じWi-Fiから接続する場合は、パソコンのLANアドレスを指定します。

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

ペアリングコードは有効期限つきの接続トークンを含みます。スクリーンショットで共有せず、パスワードと同じように扱ってください。

通常起動では、実際のこのコンピュータだけが表示され、デモセッションは混ざりません。スクリーンショットやデモ用の架空セッションが必要な場合だけ、次のように起動します。

```bash
npx orbitory-host@latest --demo
```

Claude Code / Codex などのAIプロバイダーを表示したい場合は、作業したいプロジェクトフォルダでセットアップを実行します。

```bash
npx orbitory-host@latest --setup
```

表示された選択肢からCodexまたはClaude Codeを選びます。未ログインなら、このPCの公式ログイン画面か、スマホを使う方法を遹べます。Orbitory自体はパスワードやOAuthトークンを受け取りません。

セットアップ後はそのプロジェクト用の `orbitory.config.json` が作られます。最新版のhostがすでに起動中なら設定は自動再読込されるため、二重起動せずOrbitoryで「更新」を押します。hostが動いていない場合だけ、同じフォルダで `npx orbitory-host@latest` を起動します。手動で細かく確認したい場合は、従来どおり `npx orbitory-host@latest --init-config` も使えます。

## Approval Gates

This package can be packed and tested locally. Creating a public repository, pushing a public mirror, or running `npm publish` requires explicit owner approval.
