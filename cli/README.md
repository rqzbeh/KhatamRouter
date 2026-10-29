# KhatamRouter - Dual-Runtime AI Gateway & Proxy

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Frqzbeh%2Fkhatamrouter-blue?logo=github)](https://github.com/rqzbeh/KhatamRouter/pkgs/container/khatamrouter)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-rqzbeh%2FKhatamRouter-blue?logo=github)](https://github.com/rqzbeh/KhatamRouter)

---

## Why KhatamRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**KhatamRouter solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI
- ✅ **Bun & SQLite Engine** - Native `bun:sqlite` with WAL journal mode and Redis support

---

## ⚡ Quick Start

### Option 1 — Docker (Recommended for Server / Container)

```bash
docker run -d --name khatamrouter -p 20128:20128 \
  -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/rqzbeh/khatamrouter:latest
```

Published container image: [GHCR](https://github.com/rqzbeh/KhatamRouter/pkgs/container/khatamrouter) (multi-platform amd64/arm64).

### Option 2 — Bun Source (Recommended for Local Development)

```bash
git clone https://github.com/rqzbeh/KhatamRouter.git
cd KhatamRouter
bun install
bun run build:bun && PORT=20128 bun run start:bun
```

### Option 3 — KhatamRouter CLI Launcher

Install globally or run on-demand using Bun (Bun fetches packages directly from the npm registry):

```bash
# Install globally via Bun
bun add -g 9router

# Or run directly without installing
bunx 9router

# Start gateway server (requires Bun runtime on PATH)
khatamrouter
# Or using the backward-compatible alias:
9router
```

Alternatively, run via **Docker** (Option 1 above) or download standalone releases from [GitHub Releases](https://github.com/rqzbeh/KhatamRouter/releases).

🎉 Dashboard opens at `http://localhost:20128`

**Connect a Provider:**
Dashboard → Providers → Connect your API keys or free providers.

**Use in your CLI tool:**

```
Claude Code / Codex / OpenCode / Cursor Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

---

## 🚀 CLI Options

```bash
khatamrouter                    # Start with default settings
khatamrouter --port 8080        # Custom port
khatamrouter --no-browser       # Don't open browser
khatamrouter --skip-update      # Skip auto-update check
khatamrouter --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 💾 Data Location

- **macOS/Linux**: `~/.9router/db/data.sqlite`
- **Windows**: `%APPDATA%/9router/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.9router` to persist)

---

## 📚 Documentation & Repository

- **GitHub Repository**: https://github.com/rqzbeh/KhatamRouter
- **Releases**: https://github.com/rqzbeh/KhatamRouter/releases

---

## 🙏 Lineage & Acknowledgments

- **decolua/9router** - Upstream architecture and proxy gateway
- **Vanszs/VansRouter** - Upstream provider parity features
- **CLIProxyAPI** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
