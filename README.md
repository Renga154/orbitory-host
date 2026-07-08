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
- Demo sessions enabled for the package CLI so external testers see activity immediately.
- A development fallback pairing token if `ORBITORY_PAIRING_TOKEN` is unset. The server prints a loud warning for this; set a real token before exposing the host beyond local testing.

## Safer Local Run

```bash
export ORBITORY_PAIRING_TOKEN="$(openssl rand -hex 24)"
export ORBITORY_ADVERTISED_HOST="192.168.1.10"
npx orbitory-host@latest
```

The pairing code still contains a device token until it expires. Treat the terminal QR/code like a password.

## Real Agent Configuration

Real Claude Code and Codex adapters are alpha and host-configured. The phone can start only enabled provider IDs from your local config; it never sends commands, args, env, images, working directories, or sandbox settings.

Create a local `orbitory.config.json` only on the host computer:

```bash
cp orbitory.config.example.json orbitory.config.json
```

Keep real credential-bearing projects disposable until you have reviewed the config, sandbox, and security notes. Tests use fake CLIs only.

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

## Approval Gates

This package can be packed and tested locally. Creating a public repository, pushing a public mirror, or running `npm publish` requires explicit owner approval.
