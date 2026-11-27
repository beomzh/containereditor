# Dockerfile エディター

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | 日本語

**Dockerfile / Containerfile** を作成・編集し、検査し、できあがるイメージを確認してビルドします。Web とコマンドラインの両方で使え、外部パッケージは不要です。

## インストール

Node.js 22 以上が必要です。ビルドには Docker か Podman も必要です。

```bash
npm install -g github:beomzh/dockereditor#v0.2.0
```

## クイックスタート

```bash
dockereditor new node --lang ja
```

```bash
dockereditor validate --lang ja
```

```bash
dockereditor serve --allow-build --lang ja
```

表示された URL を開きます。中央で編集し、**① イメージ確認**、**② ビルド** の順に使います。

## Web エディター

| 領域 | 機能 |
|---|---|
| エディター | 構文の色分け、問題行の表示、メッセージをクリックして移動 |
| ステージと設定 (左) | `FROM` の変更、`ARG` `ENV` `LABEL` `USER` `WORKDIR` `EXPOSE` `CMD` `ENTRYPOINT` の追加・変更・削除、ステージの追加・削除・分割・書き出し |
| 結果プレビュー | ステージの流れ、起動プロセス、ユーザー、環境変数、ポート、コピーされるファイル、レイヤー、`--build-arg` の試行 |
| 互換性 | ベースイメージが linux/amd64、linux/arm64、windows/amd64、windows/arm64 にあるか |
| ビルド | 実際のビルド。結果の場所を前後で表示 |

言語: 英語 (既定)、韓国語、中国語、日本語。

## コマンドライン

| コマンド | 説明 |
|---|---|
| `validate [ファイル]` | 構文とベストプラクティスの検査 (`--strict`、`--json`) |
| `check [ファイル]` | `FROM` イメージの存在確認とプラットフォーム表。`--platform` で指定したものが非対応なら失敗 |
| `preview [ファイル]` | ステージと結果イメージ (`--online` はベースの設定も取得) |
| `new [テンプレート]` | `node`、`go`、`python`、`java`、`windows`、`blank` |
| `add` / `set` / `remove` / `from` | 命令の編集。例: `set Dockerfile ENV NODE_ENV=production` |
| `stage add\|remove\|rename\|split\|extract` | ステージ操作 |
| `build [ファイル]` | Docker/Podman でビルド (`--dry-run` はコマンドのみ表示) |
| `serve` | Web エディターを起動 |

ファイルを省略すると `Dockerfile`、次に `Containerfile` を使います。全オプションは `dockereditor --help --lang ja`。終了コード: `0` 正常、`1` 問題あり、`2` 使い方の誤り、`3` ビルド失敗。

## ビルド結果の出力先

| `--output` | 結果 | 場所 |
|---|---|---|
| `image` (既定) | `--tag` のイメージ | エンジンのローカルイメージストア。Docker Desktop や Podman machine では仮想マシン内 |
| `archive` | `docker load` 用の `.tar` | `--dest` で指定したファイル |
| `folder` | 最終ステージのファイル | `--dest` で指定したフォルダー |

場所はビルド**開始前に**表示します。既存ファイルと空でないフォルダーは上書きしません (CLI は `--force`)。元の Dockerfile は変更しません。

## 対応プラットフォーム

| ホスト | ツールとテスト | CI での実ビルド |
|---|---|---|
| Linux amd64 / arm64 | 対応 | 確認 |
| Windows amd64 | 対応 | 確認 (Windows コンテナー: イメージ、アーカイブ) |
| Windows arm64 | 対応 | 未確認 (CI ランナーに Docker がない) |

- Linux イメージには Linux エンジン、Windows イメージには Windows の Docker デーモンが必要です。
- Windows デーモンはフォルダー展開に対応していません。
- 別の CPU アーキテクチャーのビルドには QEMU エミュレーションが必要です。
- Podman は Docker と同じ形で呼び出しますが、CI では試験していません。

## リモートの Linux サーバーで使う

サーバーは `127.0.0.1` のみで待ち受けます。手元でトンネルを開き、サーバーで `dockereditor serve` を実行してください。

```bash
ssh -L 4173:localhost:4173 user@server
```

## 制限

- プレビューはビルドせずに解釈するため、`RUN` で作られるファイルやユーザーは表示されません。
- 独自の検査ルールのため、Docker/Podman のすべてのエラーは検出できません。
- ログインが必要な非公開イメージは確認できません。
- Docker Hub は匿名リクエストに上限があります。
- フォームや `set` で `ARG`/`ENV` を変更すると、その命令内のコメントや引用符の形が変わることがあります。

## セキュリティ

ビルドは Dockerfile のコマンドをあなたのマシンで実行します。ブラウザーからのビルドは `--allow-build` が必要で、表示された URL のトークンを使い、ワークスペース内に制限されます。詳細: [SECURITY.ja.md](SECURITY.ja.md)。

## ライセンス

[Apache-2.0](LICENSE) © 2026 beomzh
