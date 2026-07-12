# Orbitory Host セットアップ

## 1. ホストを起動する

```bash
npx orbitory-host@latest
```

通常起動では、iPhoneにはこのコンピュータだけが表示され、デモ用の架空セッションは混ざりません。スクリーンショットやデモ確認をしたい時だけ、次のように起動します。

```bash
npx orbitory-host@latest --demo
```

iPhoneを同じWi-Fiから接続する場合は、パソコンのLANアドレスを指定します。

```bash
ORBITORY_ADVERTISED_HOST=192.168.1.10 npx orbitory-host@latest
```

ターミナルは開いたままにしてください。表示されるQRコードとペアリングURLは接続用の秘密情報です。

## 2. iPhoneアプリとペアリングする

1. iPhoneでOrbitoryを開きます。
2. Settingsを開きます。
3. セットアップガイドを開きます。
4. QRコードを読み取るか、`orbitory://pair?...` のURLを貼り付けます。

QRの初回ペアリング権限は既定で10分で失効します。保存済みプロファイルから最初に接続すると、同じiPhoneプロファイルに紐づく30日間のスライド更新型端末資格へ昇格するため、通常の再接続で10分ごとに読み直す必要はありません。初回コードが期限切れになった場合、またはアプリに再ペアリングが必要と表示された場合だけ、ホストコマンドを再起動して新しいコードを一度読み取ってください。

## 3. 実エージェントを設定する

Claude CodeやCodexの実プロバイダを使うには、ホスト側だけに置く `orbitory.config.json` が必要です。iPhone側からプロバイダ設定を作成・編集することはできません。

作業したいプロジェクトフォルダで、次を実行します。

```bash
npx orbitory-host@latest --setup
```

CodexまたはClaude Codeを選ぶと、そのフォルダの `orbitory.config.json` が作成/更新され、選んだプロバイダーが有効化されます。
セットアップは、選んだCLIがインストール済みか、ログイン済みかを先に確認します。見つけた実行ファイルの絶対パスをホスト専用設定に保存するため、nvmやバックグラウンド起動のPATH差に左右されません。CLIがなければ、利用不能な設定は作らず、公式インストール先を表示して終了します。

Claude Codeでは、空の一時フォルダ、ツール無効、履歴保存なしの最小応答も一度確認します。`claude auth status`がログイン済みでもAPIが401を返す古い認証情報を見逃さないためです。プロジェクト内容は送りませんが、Claudeの利用量をごく少量使う場合があります。

CLIがインストール済みで未ログインの場合は、セットアップ中に認証方法を選びます。

- `browser`: このPCでCodex / Claude Codeの公式ログイン画面を開きます。
- `phone`: Codexはデバイスコードを表示し、スマホの公式ページで承認できます。Claude Codeは表示URLをスマホで開き、返ったコードをPCのターミナルに入力します。
- `later`: 設定を有効化せず終了します。

OrbitoryはパスワードやOAuthトークンを受け取りません。認証はPC上の各AI公式CLIが直接処理します。PCでのホスト起動は必要ですが、Codexのログイン承認自体はスマホで完了できます。

host-agentがすでに起動中なら、最新版は修正後の設定を自動で読み込みます。二重起動せず、iPhoneの「更新」を押してください。host-agentが起動していない場合だけ、同じフォルダで次を実行します。

```bash
npx orbitory-host@latest
```

ローカルで素早くやり直す場合は、次のように非対話でも設定できます。

```bash
npx orbitory-host@latest --setup codex --yes
```

`--yes` は自動でログイン画面を開きません。未ログイン時に認証も行う場合は、次のどちらかを使います。

```bash
npx orbitory-host@latest --setup codex --login-device --yes
npx orbitory-host@latest --setup claude --login-browser --yes
```

Codexでは、指示ごとに公開の `codex exec --json` を1ターン実行し、次の指示ではMac側だけに保持したセッションを再開します。最近のプロジェクトと既存のCodexセッションを一覧へ追加する場合は、明示的に有効化します。

```bash
npx orbitory-host@latest --setup codex --include-codex-projects --yes
```

これはCodexの実験的なローカルapp-serverを、時間・件数を制限した読み取り専用の履歴一覧取得にだけ使用します。app-serverの書き込み状態は一時領域に隔離し、Codexの認証情報や設定はそこへコピーしません。ペアリング済みiPhoneから対象プロジェクトを開始・再開できる広い権限になるため、内容を理解した場合だけ有効化してください。パス、プロンプト本文、Codexの生thread IDはPC側だけに保持されます。履歴アクセスは `npx orbitory-host@latest --setup codex --yes` を履歴フラグなしで再実行するか、`projectCatalog.codexHistory` を無効にすると取り消せます。

Claude Codeでも同じ検出フォルダで**新規**セッションを開始する場合は、明示的に許可します。

```bash
npx orbitory-host@latest --setup claude --include-recent-projects --yes
```

これはClaudeをホスト側の広域プロジェクト許可に追加します。Claudeの非公開履歴は読まず、Claudeセッションの再開はできません。検出フォルダはCodexのサニタイズ済み一覧を使います。取り消すには `--include-recent-projects` なしでClaudeセットアップを再実行します。

プロバイダーの管理は引き続きPC上だけで行います。

```bash
npx orbitory-host@latest --list-providers
npx orbitory-host@latest --remove-provider <provider-id>
```

詳細を手動で確認したい場合は、従来どおり `npx orbitory-host@latest --init-config` も使えます。こちらは安全なデモプロバイダーだけを有効化し、Claude Code / Codex のテンプレートは無効状態で作成します。実CLIは、破棄可能なプロジェクトだけに使ってください。

## 4. ホストを停止する

ターミナルで `Ctrl-C` を押します。host-agent はサーバーを閉じ、ローカル探索が有効なら広告も停止します。

## トラブルシューティング

- iPhoneから接続できない: `127.0.0.1` ではなく、パソコンのLAN IPを `ORBITORY_ADVERTISED_HOST` に指定してください。
- QRが期限切れ: ホストのコマンドを起動し直して、新しいコードを読み取ってください。
- トークン警告が出る: 簡単なローカル確認を超える用途では、`ORBITORY_PAIRING_TOKEN` にランダムな値を設定してください。
- プロバイダーが「利用不可」: 作業フォルダで `npx orbitory-host@latest --setup` を再実行し、Orbitoryで「更新」を押してください。最新ホストは設定を自動再読込します。
- プロバイダーCLIが見つからない: セットアップが表示する公式URLからインストールし、同じコマンドを再実行します。OrbitoryがAIプロバイダー自体をインストールしたり、代わりに認証したりすることはありません。
- Claudeがログイン済みと表示するのに認証失敗する: ローカル認証情報が古くなっています。`claude auth login` を実行し、Claude公式ページで承認後、`npx orbitory-host@latest --setup claude --yes` を再実行します。
- `EADDRINUSE ... 0.0.0.0:4000`: AI連携の失敗ではなく、4000番ポートで別のホストが起動中です。すでにOrbitory hostが動いている場合は二重起動せず、アプリで「更新」を押します。古いhostの場合はそのターミナルで `Ctrl-C` を押し、`npx orbitory-host@latest` を起動し直します。
- nvmが `.npmrc` の `prefix/globalconfig` 警告を出す: Orbitoryの設定結果とは別のNode.js環境警告です。コマンドが続行していれば設定自体は可能です。必要な場合は警告に表示された `nvm use --delete-prefix <version> --silent` を実行します。
