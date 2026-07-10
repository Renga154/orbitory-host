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

コードには有効期限があります。期限切れで失敗した場合は、ホストのコマンドを起動し直して新しいコードを読み取ってください。

## 3. 実エージェントを設定する

Claude CodeやCodexの実プロバイダを使うには、ホスト側だけに置く `orbitory.config.json` が必要です。iPhone側からプロバイダ設定を作成・編集することはできません。

作業したいプロジェクトフォルダで、次を実行します。

```bash
npx orbitory-host@latest --setup
```

CodexまたはClaude Codeを選ぶと、そのフォルダの `orbitory.config.json` が作成/更新され、選んだプロバイダーが有効化されます。
セットアップは、選んだCLIがインストール済みか、ログイン済みかを先に確認します。見つけた実行ファイルの絶対パスをホスト専用設定に保存するため、nvmやバックグラウンド起動のPATH差に左右されません。CLIがなければ、利用不能な設定は作らず、公式インストール先を表示して終了します。

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

詳細を手動で確認したい場合は、従来どおり `npx orbitory-host@latest --init-config` も使えます。こちらは安全なデモプロバイダーだけを有効化し、Claude Code / Codex のテンプレートは無効状態で作成します。実CLIは、破棄可能なプロジェクトだけに使ってください。

## 4. ホストを停止する

ターミナルで `Ctrl-C` を押します。host-agent はサーバーを閉じ、ローカル探索が有効なら広告も停止します。

## トラブルシューティング

- iPhoneから接続できない: `127.0.0.1` ではなく、パソコンのLAN IPを `ORBITORY_ADVERTISED_HOST` に指定してください。
- QRが期限切れ: ホストのコマンドを起動し直して、新しいコードを読み取ってください。
- トークン警告が出る: 簡単なローカル確認を超える用途では、`ORBITORY_PAIRING_TOKEN` にランダムな値を設定してください。
- プロバイダーが「利用不可」: 作業フォルダで `npx orbitory-host@latest --setup` を再実行し、Orbitoryで「更新」を押してください。最新ホストは設定を自動再読込します。
- プロバイダーCLIが見つからない: セットアップが表示する公式URLからインストールし、同じコマンドを再実行します。OrbitoryがAIプロバイダー自体をインストールしたり、代わりに認証したりすることはありません。
- `EADDRINUSE ... 0.0.0.0:4000`: AI連携の失敗ではなく、4000番ポートで別のホストが起動中です。すでにOrbitory hostが動いている場合は二重起動せず、アプリで「更新」を押します。古いhostの場合はそのターミナルで `Ctrl-C` を押し、`npx orbitory-host@latest` を起動し直します。
- nvmが `.npmrc` の `prefix/globalconfig` 警告を出す: Orbitoryの設定結果とは別のNode.js環境警告です。コマンドが続行していれば設定自体は可能です。必要な場合は警告に表示された `nvm use --delete-prefix <version> --silent` を実行します。
