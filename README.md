# Orbitory Host

Orbitory Host is the local computer-side agent for Orbitory, an iPhone workroom for AI coding agents. It runs on your Mac or Linux machine, exposes a local HTTP/WebSocket endpoint, and prints a pairing code the iOS app can scan.

This package is early alpha software. It is local-first supervision tooling, not a remote desktop, not a mobile IDE, and not a hosted execution service.

## Quick Start

```bash
npx orbitory-host@latest
```

The command starts the host-agent and prints a sensitive `orbitory://pair?...` code plus a terminal QR block.
Orbitory is alpha and host-configured in this phase; in practice the iPhone can only launch providers the host has
enabled in its local config. In the Orbitory iOS app, open Settings, start the setup guide, and scan that QR code.

For a phone on the same Wi-Fi network, set the advertised host to your computer's LAN address:

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

For an iPhone on 4G or elsewhere, use a private Tailnet address instead of LAN:

```bash
npx orbitory-host@latest --tailscale
```

`--tailscale` requires the Tailscale CLI on the host, a logged-in tailnet node, and a private
100.64.0.0/10 IPv4. It sets `ORBITORY_ADVERTISED_HOST` internally and does not support any Tunnel/Funnel/Serve
mode in Orbitory.

`--relay` is not a remote-access mode in this release. It is a maintainer security preflight that intentionally
exits before the host starts because no externally reviewed end-to-end encryption transport is bundled. Do not
place this host directly on the public internet; use same-LAN access or the private Tailscale route above.

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
The QR grant is short-lived (10 minutes by default); its first successful saved-profile connection
binds it to that iPhone profile and promotes it to a sliding 30-day device credential. Normal
background/Wi-Fi reconnects therefore do not require rescanning every 10 minutes. Configure the
device lifetime with `ORBITORY_DEVICE_TOKEN_TTL_SECONDS`.

## Real Agent Configuration

Real Claude Code and Codex adapters are alpha and host-configured. The phone can start only enabled provider IDs from your local config; it never sends commands, args, env, images, working directories, or sandbox settings.
The launch intent now uses only host-provided opaque IDs from `providers.snapshot` and `session.launch`; iOS sends
`providerId`, `launchProfileId`, `modelId`, `permissionProfileId`, `toolsetId`, and optionally project/resume IDs, never raw paths.
`session.start` remains backward-compatible where appropriate, but strict control fields now route through `session.launch`.

From the project folder you want the AI to work in, run the guided setup:

```bash
npx orbitory-host@latest --setup
```

Choose Codex or Claude Code when prompted. Setup verifies that the CLI exists, pins its detected absolute path in the host-only config, and checks login before enabling it. When that provider already exists for the folder, the pinned executable wins over a different duplicate found earlier on PATH. Claude setup additionally runs one no-tools, no-history response from an empty temporary directory so stale credentials that return API 401 are not mistaken for a usable login; this sends no project content but may consume a very small amount of Claude allowance. If the CLI is signed out, choose browser login or phone login. Orbitory delegates authentication to the provider's official CLI and never receives your password or OAuth token. Codex phone login uses its official device-code flow; Claude Code can show a URL and return code for a phone browser.

Orbitory writes or updates the host-local `orbitory.config.json` with that provider enabled for the current folder. A host already running the latest package reloads the config automatically, so tap Refresh in Orbitory instead of starting a second copy. If no host is running, start `npx orbitory-host@latest` from the same folder. For scripts or a fast local retry:

```bash
npx orbitory-host@latest --setup codex --yes
```

To explicitly include authentication in a scripted setup:

```bash
npx orbitory-host@latest --setup codex --login-device --yes
npx orbitory-host@latest --setup claude --login-browser --yes
```

Codex sessions use the public JSONL CLI surface: each phone message runs one bounded
`codex exec --json` turn, and later messages resume the host-held Codex thread. To also show recent
Codex projects and resume existing Codex tasks, opt in locally (experimental, broad project access):

```bash
npx orbitory-host@latest --setup codex --include-codex-projects --yes
```

The app receives only opaque project/resume ids; paths and real Codex/Claude session ids remain on the Mac.
App-server writable state uses a disposable home, and Orbitory does not copy Codex authentication or
configuration into it. To allow Claude Code to start new sessions in the same discovered folders and
show recent resumable Claude chats, explicitly run:

```bash
npx orbitory-host@latest --setup claude --include-recent-projects --yes
```

Claude history indexing is metadata-only and experimental. The host scans only direct recent session
files under the official Claude state directory, reads bounded head/tail segments, and keeps the project,
updated time, session id, and an optional short title/slug on the Mac. Conversation messages, tool data,
source, diffs, paths, credentials, and real session ids are never added to the phone catalog. When Claude
did not persist a title, Orbitory uses the update time so otherwise identical chat rooms remain distinguishable.

To let the app create a new empty project, explicitly approve one parent folder and provider on the
computer:

```bash
npx orbitory-host@latest --setup codex --allow-project-creation --project-root "$HOME/Development" --yes
npx orbitory-host@latest --setup claude --allow-project-creation --project-root "$HOME/Development" --yes
```

This permission is provider-scoped. Orbitory sends only a validated project name and provider id;
the approved root and resulting path stay on the computer. The host creates one empty direct child
with its ownership marker and refuses traversal, separators, symlinks, and pre-existing folders. It
never treats the project name as a command. To revoke the permission, rerun the guided setup for that
provider and answer **No** to project creation, or remove that provider from
`projectCatalog.creation.providerIds` in the host-local config. A non-interactive `--yes` setup
without the creation flag preserves the existing choice instead of silently changing it.

List or remove mistaken provider entries from the same folder:

```bash
npx orbitory-host@latest --list-providers
npx orbitory-host@latest --remove-provider <provider-id>
```

Advanced/manual path: `npx orbitory-host@latest --init-config` still writes a starter config with a safe demo provider enabled and Claude Code/Codex templates disabled. Keep real credential-bearing projects disposable until you have reviewed the config, sandbox, and security notes. Tests use fake CLIs only.

## TLS

Plaintext local WebSocket is the default for development. For local TLS/WSS:

```bash
npx orbitory-host@latest --help
```

Package-level TLS helper scripts are included for source installs; published package usage will document the stable TLS path as it hardens.
`--help` also lists the current option set; there is no `--funnel` or `--serve` support in this
phase.

## 日本語クイックスタート

```bash
npx orbitory-host@latest
```

起動すると、ターミナルに `orbitory://pair?...` のペアリングコードとQRが表示されます。iOS版 Orbitory の Settings からセットアップガイドを開き、QRコードを読み取ってください。

iPhoneと同じWi-Fiから接続する場合は、パソコンのLANアドレスを指定します。

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

4Gや別ネットワークから接続する場合は、ホストと同じTailnet上で次を使います。

```bash
npx orbitory-host@latest --tailscale
```

`--tailscale` は秘密情報を外部公開するFunnel/Serveとは別で、TailscaleのプライベートIPv4を
自動検出して `ORBITORY_ADVERTISED_HOST` として使用します。iPhone側はQR/Pasteで接続し、`Funnel` /
`Serve` は利用しません。

`--relay` は、このリリースでは4G接続を有効にする機能ではありません。外部監査済みの
エンドツーエンド暗号化実装が未搭載のため、ホスト起動前に必ず停止する保守者向けセキュリティ
プリフライトです。ホストを直接インターネットへ公開せず、同一LANまたは上記のプライベートな
Tailscale経路を利用してください。

ペアリングコードは有効期限つきの接続トークンを含みます。スクリーンショットで共有せず、パスワードと同じように扱ってください。

通常起動では、実際のこのコンピュータだけが表示され、デモセッションは混ざりません。スクリーンショットやデモ用の架空セッションが必要な場合だけ、次のように起動します。

```bash
npx orbitory-host@latest --demo
```

Claude Code / Codex などのAIプロバイダーを表示したい場合は、作業したいプロジェクトフォルダでセットアップを実行します。

```bash
npx orbitory-host@latest --setup
```

表示された選択肢からCodexまたはClaude Codeを選びます。既存設定がある場合は、PATH上の別バージョンではなく、そのフォルダに保存済みの実行ファイルを優先します。未ログインなら、このPCの公式ログイン画面か、スマホを使う方法を選べます。Orbitory自体はパスワードやOAuthトークンを受け取りません。

Codexでは、スマホから送る指示ごとに公開JSONL CLIで1ターン実行し、次の指示はMac側だけに保持したCodexセッションを再開します。Codexアプリの最近のプロジェクトと既存セッションも表示する場合は、広いプロジェクトアクセスを理解した上で明示的に有効化します（実験的機能です）。

```bash
npx orbitory-host@latest --setup codex --include-codex-projects --yes
```

履歴アクセスを取り消す場合は、同じフォルダで `--include-codex-projects` を付けずにCodexセットアップを再実行します。

```bash
npx orbitory-host@latest --setup codex --yes
```

Claude Codeも検出フォルダで新規セッションを開始し、最近のチャットを再開できるようにする場合は、明示的に許可します。

```bash
npx orbitory-host@latest --setup claude --include-recent-projects --yes
```

Claude履歴の取得は実験的なメタデータ限定機能です。Mac上で直下の最近セッションの先頭・末尾だけを上限付きで読み、プロジェクト、更新時刻、セッションID、保存済みの短いタイトルのみをMac内で保持します。会話本文、ツール入出力、ソース、diff、実パス、認証情報、実セッションIDはiPhoneへ送りません。Claudeがタイトルを保存していないチャットは、更新時刻で区別します。

Orbitoryから空の新規プロジェクトを作る場合は、PC上で親フォルダと利用できるプロバイダーを明示的に許可します。

```bash
npx orbitory-host@latest --setup codex --allow-project-creation --project-root "$HOME/Development" --yes
npx orbitory-host@latest --setup claude --allow-project-creation --project-root "$HOME/Development" --yes
```

許可はプロバイダー単位です。iPhoneが送るのは検証対象のプロジェクト名とプロバイダーIDだけで、許可した親フォルダや作成後の実パスはPC内に残ります。hostは親フォルダ直下に空フォルダと所有マーカーを作り、パストラバーサル、区切り文字、シンボリックリンク、既存フォルダを拒否します。プロジェクト名をコマンドとして実行することはありません。権限を取り消す場合は、そのプロバイダーの対話セットアップを再実行して新規作成を「No」にするか、PC内の `projectCatalog.creation.providerIds` から対象を外します。作成フラグなしの非対話 `--yes` セットアップは、既存の選択を勝手に変更せず維持します。

誤って追加したプロバイダーは、同じフォルダで一覧確認して削除できます。app-serverの書き込み状態は一時領域に隔離し、Codexの認証情報や設定はそこへコピーしません。実際のパスやCodexのthread IDはiPhoneへ送られません。

```bash
npx orbitory-host@latest --list-providers
npx orbitory-host@latest --remove-provider <provider-id>
```

セットアップ後はそのプロジェクト用の `orbitory.config.json` が作られます。最新版のhostがすでに起動中なら設定は自動再読込されるため、二重起動せずOrbitoryで「更新」を押します。hostが動いていない場合だけ、同じフォルダで `npx orbitory-host@latest` を起動します。手動で細かく確認したい場合は、従来どおり `npx orbitory-host@latest --init-config` も使えます。

## Approval Gates

This package can be packed and tested locally. Creating a public repository, pushing a public mirror, or running `npm publish` requires explicit owner approval.
