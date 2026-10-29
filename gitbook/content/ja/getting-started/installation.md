# インストール

トラブルシューティングのヒント付きの9Router詳細インストールガイド。

---

## 要件

### システム要件

- **Bun**: バージョン 1.4.3以上 (https://bun.sh)
- **OS**: macOS、Linux、Windows (WSL推奨)
- **ディスク容量**: インストールに約200MB

### バージョンを確認

```bash
bun --version
# v20.x.x以上が表示されるはず

```

**Bunがない場合?** [bun.sh](https://bun.sh)からインストール

---

## インストール方法

### 方法1: グローバルインストール (推奨)

どこからでも使用できるように9Routerをグローバルインストール:

```bash
bun add -g 9router
```

**9Routerを起動:**

```bash
9router
```

**利点:**
- ✅ どのディレクトリからでも実行
- ✅ シンプルなコマンド: `9router`
- ✅ `bun update -g 9router` で自動更新

### 方法2: ローカルインストール

特定のプロジェクトにインストール:

```bash
mkdir my-9router
cd my-9router
bun add 9router
```

**9Routerを起動:**

```bash
bunx 9router
```

**利点:**
- ✅ プロジェクトごとに分離
- ✅ プロジェクトごとのバージョン管理
- ✅ グローバル名前空間の汚染なし

### 方法3: ソースから (開発)

GitHubからクローンしてビルド:

```bash
git clone https://github.com/decolua/9router.git
cd 9router/app
bun install
bun run build:bun
bun run start:bun
```

**利点:**
- ✅ 最新の開発機能
- ✅ 開発に貢献可能
- ✅ カスタム変更

---

## 初回実行

### サーバーを起動

```bash
9router
```

**何が起こるか:**
1. サーバーが `http://localhost:20128` で起動
2. ダッシュボードが自動的にブラウザで開く
3. `~/.9router` にデータディレクトリが作成される
4. APIキーが自動生成される

### ダッシュボードログイン

**デフォルト認証情報:**
- パスワード: `123456`

**⚠️ パスワードをすぐに変更:**
1. ダッシュボードにログイン
2. Settings → Change Password
3. 強力なパスワードを使用

### APIキーを取得

```
Dashboard → Settings → API Keys
→ APIキーをコピー
→ CLIツールで使用
```

**APIキー形式の例:**
```
9r_1234567890abcdef1234567890abcdef
```

---

## インストールを確認

### サーバーステータスを確認

```bash
curl http://localhost:20128/health
```

**期待されるレスポンス:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

### 利用可能なモデルを一覧表示

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer your-api-key"
```

**期待されるレスポンス:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "cc/claude-opus-4-5-20251101",
      "object": "model",
      "created": 1234567890,
      "owned_by": "claude-code"
    }
  ]
}
```

### チャットコンプリーションをテスト

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cc/claude-opus-4-5-20251101",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

---

## 設定

### 環境変数

`.env` ファイルを作成するか、環境変数を設定:

```bash
# セキュリティ (本番環境では必須)
export JWT_SECRET="your-secure-secret-change-this"
export INITIAL_PASSWORD="your-password"

# ストレージ
export DATA_DIR="~/.9router"

# サーバー
export PORT="20128"
export NODE_ENV="production"

# ロギング
export ENABLE_REQUEST_LOGS="false"
```

### データディレクトリ

**デフォルトの場所:** `~/.9router`

**内容:**
```
~/.9router/
  ├── db.json           # データベース (プロバイダー、コンボ、使用量)
  ├── api-keys.json     # APIキー
  └── logs/             # リクエストログ (有効化されている場合)
```

**場所を変更:**

```bash
export DATA_DIR="/custom/path"
9router
```

### ポート設定

**デフォルトポート:** `20128`

**ポートを変更:**

```bash
export PORT="3000"
9router
```

**またはコマンドラインで:**

```bash
9router --port 3000
```

---

## トラブルシューティング

### ポートがすでに使用されている

**エラー:**
```
Error: listen EADDRINUSE: address already in use :::20128
```

**解決策1: 既存のプロセスを終了**

```bash
# ポート20128を使用しているプロセスを検索
lsof -i :20128

# プロセスを終了
kill -9 <PID>
```

**解決策2: 別のポートを使用**

```bash
9router --port 3000
```

### Permission Denied

**エラー:**
```
Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/9router'
```

**解決策: sudoを使用 (非推奨) またはnpm権限を修正**

```bash
# npm権限を修正 (推奨)
echo 'export PATH=~/.bun/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# 再度インストール
bun add -g 9router
```

### Bunのバージョンが古すぎる

**エラー:**
```
Error: The engine "node" is incompatible with this module
```

**解決策: Bunを更新 (`bun upgrade`)**

```bash
# nvmを使用 (推奨)
bun upgrade

# またはbun.shからダウンロード
```

### ダッシュボードが開かない

**問題:** ダッシュボードが自動的に開かない

**解決策1: 手動で開く**

```
http://localhost:20128
```

**解決策2: ファイアウォールを確認**

```bash
# macOS: システム環境設定 → セキュリティでBunを許可
# Linux: iptablesを確認
# Windows: Windowsファイアウォールを確認
```

### プロバイダーに接続できない

**問題:** OAuthログインが失敗、またはAPIキーが無効

**解決策1: インターネット接続を確認**

```bash
ping google.com
```

**解決策2: プロバイダーのステータスを確認**

- Claude Code: [status.anthropic.com](https://status.anthropic.com)
- OpenAI: [status.openai.com](https://status.openai.com)
- Gemini: [status.cloud.google.com](https://status.cloud.google.com)

**解決策3: APIキーを再生成**

```
Dashboard → Provider → Disconnect → Reconnect
```

### 高メモリ使用量

**問題:** 9RouterがRAMを使いすぎている

**解決策: サーバーを再起動**

```bash
# 停止
pkill -f 9router

# 起動
9router
```

**または自動再起動にPM2を使用:**

```bash
bun add -g pm2
pm2 start bun --name khatamrouter -- run start:bun
pm2 save
```

---

## デプロイメントオプション

### ローカル開発

```bash
bun add -g 9router
9router
```

**ユースケース:** 個人コーディング、テスト

### VPS/クラウドサーバー

```bash
# インストール
bun add -g 9router

# 設定
export JWT_SECRET="your-secure-secret"
export INITIAL_PASSWORD="your-password"
export NODE_ENV="production"

# PM2で起動
bun add -g pm2
pm2 start bun --name khatamrouter -- run start:bun
pm2 save
pm2 startup
```

**ユースケース:** チームアクセス、リモートコーディング

### Docker

```bash
docker pull ghcr.io/rqzbeh/khatamrouter:latest

docker run -d \
  -p 20128:20128 \
  -e JWT_SECRET="your-secure-secret" \
  -e INITIAL_PASSWORD="your-password" \
  -v 9router-data:/root/.9router \
  --name 9router \
  ghcr.io/rqzbeh/khatamrouter:latest
```

**ユースケース:** コンテナデプロイ、Kubernetes

### リバースプロキシ (Nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:20128;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        
        # SSE support for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

**ユースケース:** HTTPS、カスタムドメイン、ロードバランシング

---

## アンインストール

### グローバルインストールを削除

```bash
bun remove -g 9router
```

### データディレクトリを削除

```bash
rm -rf ~/.9router
```

### 設定を削除

```bash
# シェル設定から環境変数を削除
nano ~/.bashrc  # または ~/.zshrc
# 9router関連のエクスポートを削除
```

---

## 次のステップ

- [スタートガイド](../getting-started.md) - プロバイダーを接続してコーディング開始
- [機能](../features/) - クォータトラッキング、コンボ、デプロイを確認
- [トラブルシューティング](../troubleshooting.md) - 一般的な問題の修正

---

## ヘルプが必要?

- **ウェブサイト**: [9router.com](https://9router.com)
- **GitHub**: [github.com/decolua/9router](https://github.com/decolua/9router)
- **Issues**: [github.com/decolua/9router/issues](https://github.com/decolua/9router/issues)
