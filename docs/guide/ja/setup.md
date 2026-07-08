# Orbitory Host セットアップ

## 1. ホストを起動する

```bash
npx orbitory-host@latest
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

公開パッケージは、外部テスターがすぐ動作を見られるようにデモモードで起動します。Claude CodeやCodexの実プロバイダを使うには、ホスト側だけに置く `orbitory.config.json` が必要です。iPhone側からプロバイダ設定を作成・編集することはできません。

ホスト上でサンプルをコピーして始めます。

```bash
cp orbitory.config.example.json orbitory.config.json
```

実CLIは、サンドボックスとプロバイダ設定を確認したうえで、破棄可能なプロジェクトだけに使ってください。

## 4. ホストを停止する

ターミナルで `Ctrl-C` を押します。host-agent はサーバーを閉じ、ローカル探索が有効なら広告も停止します。

## トラブルシューティング

- iPhoneから接続できない: `127.0.0.1` ではなく、パソコンのLAN IPを `ORBITORY_ADVERTISED_HOST` に指定してください。
- QRが期限切れ: ホストのコマンドを起動し直して、新しいコードを読み取ってください。
- トークン警告が出る: 簡単なローカル確認を超える用途では、`ORBITORY_PAIRING_TOKEN` にランダムな値を設定してください。
- 実プロバイダが表示されない: ホスト側configで `enabled: true` になっているか、サンドボックス/config検証で拒否されていないか確認してください。
