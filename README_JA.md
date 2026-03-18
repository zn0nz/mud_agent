<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">中文</a> |
  <a href="./README_JA.md">日本語</a> |
  <a href="./README_FR.md">Français</a> |
  <a href="./README_ES.md">Español</a>
</p>

![aardwolf_play_sample](https://github.com/user-attachments/assets/e397507d-028f-46d3-a561-9d91730100bb)

# mud-agent

`mud-agent` は、AI コーディングエージェント経由で MUD セッションを実行するためのローカル制御インターフェースです。`tmux`、起動スクリプト、サーバーごとの設定、小規模なローカル Web サーバーを組み合わせ、エージェントがライブのゲーム出力を確認し、場当たり的なシェルパイプではなく既存のペインを通して操作できるようにします。

## 利用上の注意

MUD によっては、ボット操作、放置プレイ、その他の自動化を禁止しています。このリポジトリをゲームで使う前に、そのゲームのルールを確認し、利用方法が規約に適合していることを確認してください。

## サポート内容

- Aardwolf の組み込みサポート（`UTF-8`）
- `GBK`、`GB2312`、`BIG5` などの非 UTF-8 エンコーディングを含むカスタム MUD サーバー定義
- Codex、Claude Code、OpenClaw、OpenCode などのエージェント CLI
- `tmux` を直接使うワークフローと、`127.0.0.1` 上で動くローカルブラウザ UI

## アーキテクチャ

```text
tmux session
  -> ./scripts 内の MUD 起動スクリプト
  -> ./config 内のサーバーごとの設定
  -> ./apps/server 内のローカル制御サーバー
  -> ペイン出力、手動コマンド、対話型エージェントウィンドウ向けブラウザ UI
```

ブラウザ UI は追加機能です。`tmux capture-pane` と `tmux send-keys` を使って、引き続き直接セッションを確認、操作できます。

## 必要条件

- `tmux`
- `Node.js` 18 以上
- `npm`
- エージェント制御を使う場合は、対応するエージェント CLI を少なくとも 1 つ

サーバーによっては追加で必要になります：

- `TinTin++`（`tt++`）：同梱の Aardwolf ランチャー用
- `luit`：非 UTF-8 MUD 用
- `telnet`：telnet ベースの MUD 用

## クイックスタート

### Linux

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### macOS

必要であれば先に `tmux` をインストールしてください：

```bash
brew install tmux
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### Windows

先に WSL をセットアップし、その後 PowerShell から起動します：

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

WSL の詳細なセットアップ手順は `SETUP_WINDOWS.md` を参照してください。

`start.sh` は必要に応じて依存関係をインストールし、サンプルから `config/local.secrets.json` を作成し、tmux セッション `0` の存在を確認し、ローカル UI サーバーを起動し、ブラウザを自動で開きます。
スクリプトログインを使う前に、`config/local.secrets.json` に自分の認証情報を設定してください。

## 設定

- `config/servers.json`: 組み込みサーバー定義
- `config/agents.json`: 組み込みエージェント定義
- `config/local.secrets.json`: ローカル専用の認証情報。`config/local.secrets.example.json` を元に作成
- `config/local.servers.json`: 任意のローカルカスタムサーバー設定
- `walkthrough/`: エージェントが読み書きできるゲームメモ

認証情報はローカルマシン固有の情報であり、コミットしてはいけません。

## よく使うワークフロー

### Aardwolf

```bash
tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'
tmux capture-pane -pt 0:aardwolf | tail -n 80
tmux send-keys -t 0:aardwolf 'look' Enter
```

### 非 UTF-8 MUD

`GBK`、`GB2312`、`BIG5` などのサーバーでは、クライアントを `luit` で包み、`tmux send-keys` が不安定な場合は `./scripts/tmux-pane-send.sh` を使ってください。

```bash
tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'
./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'
tmux capture-pane -pt 0:cjk_mud | tail -n 80
```

文字コードに関する注意は `SETUP.md` を参照してください。ゲームメモや移動ルートは `walkthrough/` に保存します。

## Web 制御画面

ローカルサーバーは次のコマンドで起動します：

```bash
npm run dev
```

`127.0.0.1` にバインドされ、以下を提供します：

- tmux ペインの確認
- 手動コマンド送信
- tmux ベースの対話型エージェントウィンドウ
- `config/agents.json` に基づくエージェント起動設定

## サーバーの追加

`config/servers.json` または `config/local.servers.json` に、次の内容を持つサーバー定義を追加します：

- host と port
- encoding
- tmux の session/window 設定
- launcher command
- 任意の login command
- send mode（`tmux_keys` または `pane_tty`）

## エージェントの追加

`config/agents.json` に、次の内容を持つエージェント定義を追加します：

- CLI command と detection args
- 非対話実行用の引数
- 任意の対話型 tmux 設定
- TUI エージェント向けの ready/submit パターン

## リポジトリに関するメモ

- このリポジトリは npm パッケージではなく、ソースとして公開する想定です。
- ルートの `package.json` はローカル用途のワークスペースであるため `private` のままです。
- 秘密情報を含む git 履歴を、そのままクリーン版の公開に使わないでください。
- エージェントは長期的なゲームメモをルート直下の一時ファイルではなく `walkthrough/` に残すべきです。

## ライセンス

MIT。`LICENSE` を参照してください。
