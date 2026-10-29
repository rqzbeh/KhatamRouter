<div align="center">
  <img src="./images/9router.png?1" alt="KhatamRouter Dashboard" width="800"/>
  
  # KhatamRouter - FREE AI Router & Token Saver
  
  **Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**
  
  **Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**
  
  [![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Frqzbeh%2Fkhatamrouter-blue?logo=github)](https://github.com/users/rqzbeh/packages)
  [![Publish Docker Image](https://github.com/rqzbeh/KhatamRouter/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/rqzbeh/KhatamRouter/actions/workflows/docker-publish.yml)
  [![License](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/rqzbeh/KhatamRouter/blob/master/LICENSE)

[🚀 Quick Start](#-quick-start) • [✨ Why KhatamRouter?](#-why-khatamrouter) • [💡 Features](#-key-features) • [📖 Setup](#-setup-guide) • [🗺️ Roadmap](./ROADMAP.md) • [🌐 Docs](https://rqzbeh.github.io/KhatamRouter/)

[🇧🇷 Português (Brasil)](./i18n/README.pt-BR.md) • [🇻🇳 Tiếng Việt](./i18n/README.vi.md) • [🇨🇳 中文](./i18n/README.zh-CN.md) • [🇯🇵 日本語](./i18n/README.ja-JP.md) • [🇷🇺 Русский](./i18n/README.ru.md) • [🇹🇭 ไทย](./i18n/README.th.md) • [🇮🇷 فارسی](./i18n/README.fa_IR.md) • [🇮🇩 Indonesia](./i18n/README.id-ID.md) • [🇪🇸 Español](./i18n/README.es.md) • [🇫🇷 Français](./i18n/README.fr.md)

</div>

---

## ✨ Why KhatamRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)
- ❌ Manual switching between providers

**KhatamRouter solves this with a hardened Bun runtime stack:**

#### 🟢 Shipped Core Capabilities

- ⚡ **Bun v1.4.3 runtime** — Sub-second cold starts, lower resident memory, and control-plane orchestration powered by native `bun:sqlite`.
- 🗄️ **SQLite in WAL mode with integrity preflight** — Concurrent multi-process database sharing with a 5000ms `busy_timeout` and startup validation that refuses silent in-memory fallback over existing data.
- 🚀 **Optional Redis accelerator (`khatam:` namespace)** — Low-latency cluster-wide Pub/Sub event bus, real-time config invalidation, and sliding-window quota tracking, with automatic SQLite fallback when `REDIS_URL` is unset.
- 🗄️ **Versioned migrations & hybrid quota store** — Idempotent `_khatam_migrations` runner with backup-before-migrate safety, additive schema v3, hybrid Redis/SQLite sliding-window quota store with fail-open semantics, and 5s settings cache.
- 🎚️ **Unified Tri-State ACL & Granular Limits** — Constant-time internal trust, tri-state access control (allow/deny/passthrough across kinds, providers, combos, and models with 404 enumeration defense), `/v1/models` catalog filtering, connection concurrency/rate overrides (`rate_limit_overrides_json`), multi-window key rate limits, and USD spend caps with fail-open resilience.
- 🧱 **Hardened request ingestion** — Bounded 128 MiB JSON request bodies (`proxyClientMaxBodySize`), 64 MiB h2c chunked stream cap with strict CRLF enforcement, and immediate rejection of combined Content-Length/Transfer-Encoding smuggling attempts.
- 🛡️ **4-state resilient circuit breaker** — `CLOSED → DEGRADED → OPEN → HALF_OPEN` provider health in `src/shared/utils/circuitBreaker.js`, with 429 body classification (rate-limit vs quota exhaustion), kind-aware escalating cooldowns, `domain_circuit_breakers` persistence plus an optional `khatam:cb:` Redis mirror, and ordered pre-dispatch gates. Client 4xx errors and policy refusals never trip health; opt in with `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1`.
- 🕵️ **Stealth and anti-ban suite** — Canonical CLI header/field ordering (`src/lib/stealth/cliFingerprints.js`), reverse-proxy header scrub (`src/lib/stealth/headerScrub.js`), tool-name cloaking with schema sanitisation and bidirectional RESTORE map (`src/lib/stealth/toolCloak.js`), zero-width obfuscation with Persian half-space preservation (`src/lib/stealth/zeroWidth.js`), and first-message prompt-cache session pinning (`src/lib/stealth/stickiness.js`). Default-off behind `CLI_COMPAT_<PROVIDER>=1` / `STEALTH_*=1`.
- 🔍 **Live model discovery & capability resolution** — Defensive normalisation of upstream `/v1/models` payloads across 4 real shapes (`src/lib/models/discovery.js`), 7-tier capability precedence cascade as a pure function (`src/lib/models/capabilities.js`), self-correcting context reconciler (`src/lib/models/contextReconciler.js`) protecting manual pins, and fail-closed combo routing (`src/domain/requestCapabilities.js`, `open-sse/services/combo.js`) ensuring image requests never dispatch to non-vision targets. Default-off behind `KHATAM_MODEL_CAPABILITY_GUARD=1`.
- 🤝 **VansRouter provider parity & stateless executors** — Full provider parity porting 30 upstream providers (164 total in `open-sse/providers/registry/`), specialized executors (`open-sse/executors/agentrouter.js`, `qwen.js`, `zcode.js`, `freebuff.js`, `muse-spark-web.js`) with strictly stateless `buildHeaders` contracts, deterministic free-tier catalog derivation (`open-sse/providers/freeTiers.js`), multi-intensity Ponytail (`open-sse/rtk/ponytailPrompt.js`) with 2026 skepticism rules, and stateless anti-loop detection (`open-sse/utils/loopGuard.js`) behind default-off settings.
- 🛡️ **Upstream ports & security hardening** — 44 audit-confirmed candidates ported across VansRouter v0.91.61→v0.91.81 and 9router v0.5.104→v0.5.109 in Wave 9, plus five `decolua/9router` PRs (#4988, #5222, #5150, #5179, #5193) ported via PR #67 with security hardening (neutral CLI fingerprinting preventing host layout disclosure, strict OpenCode domain gating and bounded buffering on 403 free-tier replays, DeepSeek `json_schema` downgrade guard, context cap pinning, and probe-free free-lane dashboard tests). Hardens `undici` to 7.30.1 with loopback headroom binding, pins dashboard Monaco editor CDN loader to 0.57.0 (DOMPurify 3.4.15), patches Gemini translator against `__proto__` pollution and prototype-method shadowing, adds SSRF-safe reference image inputs for Gemini, and introduces Redis-backed Smart Router session stickiness. Complete audit ledger in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md).
- 🎛️ **Dashboard tooling** — Pure JavaScript controls: per-connection limits modal (`src/shared/components/ConnectionLimitsModal.js`), key quota tabs with spend trends (`src/app/(dashboard)/dashboard/quota/`), and 9-modality capability badges (`src/shared/components/CapacityBadges.js`).
- 🏷️ **KhatamRouter branding & release update feed** — Display branding across dashboard/landing/CLI, GitHub release update check pinned to `rqzbeh/KhatamRouter` with 512 KiB buffer cap and strict semver parsing in `src/app/api/version/route.js`, and in-place package updater neutralized (returns 403).
- ✂️ **Multi-layer token savers** — Token-reducing 10 MiB RTK tool compression (intentionally truncates verbose diffs, logs, and build outputs), Caveman terseness prompts, and YAGNI-first Ponytail (Lite/Full/Ultra) modes saving an upstream-claimed 20-40% input and up to 65% output tokens.
- 🔄 **Unified API gateway & Next.js dashboard (port 20128)** — Single lightweight endpoint serving both web dashboard and OpenAI-compatible `/v1/*` proxy routing across 40+ providers.

### 📋 Feature Implementation Status

We value engineering honesty over hype. Here is the exact status of each architectural capability across our development roadmap:

| Feature Capability | Status | Target Wave / Delivery |
| :--- | :---: | :--- |
| **Bun v1.4.3 Runtime** | 🟢 Shipped | Wave 1: Native Bun execution, `@/*` mapping, `Dockerfile.bun` |
| **SQLite WAL Engine + Integrity Preflight** | 🟢 Shipped | Wave 1: `bun:sqlite` WAL, `busy_timeout=5000`, startup integrity check |
| **Redis Accelerator & Real-Time Pub/Sub** | 🟢 Shipped | Wave 1: `khatam:` namespace, cluster invalidation, transparent SQLite fallback |
| **Versioned DB Migrations & Hybrid Quota** | 🟢 Shipped | Wave 2: Idempotent `_khatam_migrations` runner with backup-before-migrate, additive schema v3, hybrid Redis/SQLite sliding-window quota store with fail-open, 5s settings cache |
| **Unified Tri-State ACL & Internal Trust** | 🟢 Shipped | Wave 3: Pure tri-state access control (kinds, providers, combos, models), 404 enumeration defense, constant-time internal trust token |
| **Granular Per-Connection / Key Limits** | 🟢 Shipped | Wave 3: Connection concurrency/rate overrides (`rate_limit_overrides_json`), multi-window key limits (RPM/RPH/RPD), and USD spend caps with fail-open degradation |
| **Hardened Request Ingestion & Smuggling Defense** | 🟢 Shipped | HTTP/1.1 & h2c smuggling defenses, 128 MiB JSON cap, 64 MiB chunked cap |
| **Token Savers (RTK, Caveman, Ponytail)** | 🟢 Shipped | Pre-translation tool compression with 10 MiB cap, prompt injection modes |
| **4-State Resilient Circuit Breakers** | 🟢 Shipped | Wave 4: 4-state machine in `src/shared/utils/circuitBreaker.js`, 429 classification, escalating cooldowns, `domain_circuit_breakers` persistence, and pre-dispatch gates |
| **Stealth & Anti-Ban Fingerprinting** | 🟢 Shipped | Wave 5: CLI client header/field ordering in `src/lib/stealth/cliFingerprints.js`, reverse-proxy header scrub, tool-name cloaking with RESTORE map, zero-width obfuscation, session stickiness |
| **Dynamic Capability Discovery & Custom Models** | 🟢 Shipped | Wave 6: Live model discovery in `src/lib/models/discovery.js`, pure precedence cascade, self-healing context reconciler, and fail-closed combo routing |
| **VansRouter Provider Parity** | 🟢 Shipped | Wave 7: 30 ported providers (`open-sse/providers/registry/`), stateless executors (`open-sse/executors/agentrouter.js`, `zcode.js`, `qwen.js`, `freebuff.js`, `muse-spark-web.js`), free-tier catalogue (`open-sse/providers/freeTiers.js`), and default-off LoopGuard (`open-sse/utils/loopGuard.js`) |
| **Bun-Only Runtime & Redis-by-Default** | 🟢 Shipped | Wave 7.5: Bun-only server & CLI runtime, sole `bun:sqlite` engine, compose with `redis:8.2-alpine` default stack, lease semaphores, 4102 passing tests |
| **Upstream Ports & Security Hardening** | 🟢 Shipped | Wave 9: 44 candidates ported (VansRouter 0.91.81 / 9router 0.5.109); PR #67: 5 decolua/9router PRs (#4988, #5222, #5150, #5179, #5193) with security hardening; see [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md) |
| **Dashboard and Tooling** | 🟢 Shipped | PR #71 (specs), PR #72 (implementation): pure JavaScript controls: limits modal (`src/shared/components/ConnectionLimitsModal.js`, stored and displayed; connection budget cap NOT enforced at request time), key quota tabs with spend trends (`src/app/(dashboard)/dashboard/quota/`), capability badges (provider rows, model selector, combo builder via `src/shared/components/CapacityBadges.js`) |
| **Bun Performance and Scale** | 🟢 Shipped | Wave 8, PR #79 (squash `5208a6b0`, merged 2026-10-28, Verify run 40627502720 green): vertical scaling on one Bun host via `node:cluster` (`KHATAM_WORKERS`, default `Math.max(1, nproc - 2)`) plus hot-path slimming. DB queries/req 15.20 -> 10.78 (met); p95 4.93 -> 2.56 ms (-48%, met); p50 1.35 -> 1.00 ms (-25.7%, 35% target missed). Measured ladder 238 -> 361 -> 454 -> 495 req/s at 1/2/4/6 workers (8-logical-CPU WSL2, zero-latency mock): sub-linear, causes unprofiled. Without `REDIS_URL`, login lockout, rate limits, combo rotation and circuit-breaker trips are per worker; the npm `9router` CLI bundle runs single-process. Horizontal replica work was reverted (PR #77) and is not part of Wave 8. See [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) |
| **KhatamRouter Branding & Release Update Feed** | 🟢 Shipped | PR #69: UI/CLI display branding, update check targeting KhatamRouter GitHub Releases with strict semver parsing and 512 KiB buffer cap in `src/app/api/version/route.js`; in-place updater disabled (`/api/version/update` returns 403) |

The detailed per-wave plan, known limitations and non-goals are tracked in [ROADMAP.md](./ROADMAP.md); the table above remains the authoritative shipped-versus-planned summary.

---

### 🔤 What does "Khatam" mean?

In Persian and Arabic, *Khatam* (خاتم / ختم) translates to "the seal", "completion", or "the end".

Depending on how your day is going, **KhatamRouter** carries two equally valid interpretations:

1. **The Flattering Reading**: A router so capable, resilient, and comprehensive that it is the *end-all* of AI routers—the final, definitive gateway that obsoletes every other proxy on your machine.
2. **The Honest Reading**: The absolute *end* of your routing journey—because after wrestling with forty providers, fallback tiers, and distributed quotas, your setup is so delightfully compromised that no further routing is humanly possible.

We actively build for the former, but we keep the latter in mind as a healthy reminder to keep our fallbacks tested and our error logs clear.

---

## 🔄 How It Works

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, OpenClaw, Cursor, Cline...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1  (API Gateway)
       ↓
┌─────────────────────────────────────────────────────────────┐
│                KhatamRouter Architecture                    │
│                                                             │
│  [Port 20128: Unified Control & Data Plane]                 │
│   • Bun v1.4.3 + Next.js App Router                         │
│   • Provider connection manager & OAuth auto-refresh        │
│   • Real-time quota tracking & spend analytics              │
│   • OpenAI-compatible API Gateway (/v1/*)                   │
│   • RTK Token Saver (cut tool_result tokens up to 40%)      │
│   • Format translation (OpenAI ↔ Claude ↔ Gemini ↔ Kiro)    │
│   • 128 MiB JSON cap + 64 MiB h2c CRLF smuggling defense    │
│                                                             │
│  [Shared State & Acceleration Layer]                        │
│   • SQLite WAL ($DATA_DIR/db/data.sqlite, busy_timeout=5s)  │
│   • Optional Redis Accelerator (khatam:* namespace)         │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ├─→ [Tier 1: SUBSCRIPTION] Claude Code, Codex, GitHub Copilot
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM ($0.6/1M), MiniMax ($0.2/1M)
       │   ↓ budget limit
       └─→ [Tier 3: FREE] Kiro, OpenCode Free, Vertex ($300 credits)

Result: Never stop coding, minimal cost + 20-40% token savings via RTK
```

---

## 📦 Install

Bun is the only supported runtime, interpreter, and package manager. Three distribution channels:

- **Docker**: `ghcr.io/rqzbeh/khatamrouter` (see [DOCKER.md](./DOCKER.md) and Quick Start below).
- **GitHub Releases**: tagged builds at [github.com/rqzbeh/KhatamRouter/releases](https://github.com/rqzbeh/KhatamRouter/releases).
- **CLI launcher (`9router`)**: `bunx 9router` or `bun add -g 9router`. These fetch from the npm registry, which is the only npm dependency; the package requires `bun` on PATH. Install Bun from [bun.sh](https://bun.sh) (`bun upgrade` to update).

## ⚡ Quick Start

### 1. Start KhatamRouter

#### 🐳 Option A: Docker Compose with Redis (Recommended)

KhatamRouter runs with `redis:8.2-alpine` by default for high-speed coordination and distributed lease semaphores:

```bash
git clone https://github.com/rqzbeh/KhatamRouter.git
cd KhatamRouter
docker compose up -d
```

Or run standalone single container:

```bash
docker run -d \
  --name khatamrouter \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  ghcr.io/rqzbeh/khatamrouter:latest
```

🎉 **Dashboard**: `http://localhost:20128`  
🚀 **API Gateway**: `http://localhost:20128/v1`

#### ⚡ Option B: Run From Source (Bun Strictly Required)

KhatamRouter **strictly requires Bun v1.4.3+** (Node.js is not supported). The server standardizes exclusively on native `bun:sqlite` with WAL mode:

```bash
git clone https://github.com/rqzbeh/KhatamRouter.git
cd KhatamRouter
cp .env.example .env

# Install dependencies with Bun
bun install

# Start development server
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 bun run dev:bun
```

Production build with Bun:

```bash
bun run build:bun
PORT=20128 HOSTNAME=0.0.0.0 bun run start:bun
```

> **CLI launcher**: If using the published `9router` CLI launcher package, `bun` must be installed on your system PATH.

Default URLs:

- Dashboard (control plane): `http://localhost:20128/dashboard`
- OpenAI-compatible API: `http://localhost:20128/v1`

### 2. Connect a FREE provider (no signup needed):

Dashboard → Providers → Connect **Kiro AI** (~50 credits/month free: Claude 4.5 + GLM-5 + MiniMax) or **OpenCode Free** (no auth) → Done!

### 3. Use in your CLI tool:

```
Claude Code / Codex / OpenClaw / Cursor / Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key: [copy from dashboard]
  Model: kr/claude-sonnet-4.5
```

**That's it!** Start coding with FREE AI models.

### 🔄 Migrating from 9Router

Upgrading from an existing 9Router setup is completely seamless:

- **100% Data Directory Compatibility**: KhatamRouter preserves full compatibility with your existing `$HOME/.9router` configuration directory and SQLite database (`data.sqlite`). All existing providers, OAuth credentials, combos, and usage history load automatically.
- **Port Compatibility**: Any deployment setting `PORT=20128` continues to function normally; `PORT` acts as a backward-compatible alias for `DASHBOARD_PORT`.
- **API Key Compatibility**: Existing keys (including keys with `sk_9router...` prefixes) continue to validate and authenticate requests.
- **Automated Upstream Sync**: KhatamRouter runs an automated synchronization workflow against upstream `decolua/9router` to pull the latest provider registry updates and translation improvements.

---

## Video Guides

> 💡 **Community Guides:** These third-party walkthroughs were published for the upstream 9Router project by independent creators — their titles are reproduced verbatim above. The setup workflows they demonstrate remain 100% compatible with KhatamRouter.

<div align="center">

<table>
  <tr>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=X69n5Lm06Yw">
        <img src="https://img.youtube.com/vi/X69n5Lm06Yw/maxresdefault.jpg" alt="Tiết kiệm chi phí LLM với 9Router" width="300"/>
      </a><br/>
      <b>🇻🇳 Tiếng Việt</b><br/>
      <sub>Tiết kiệm chi phí LLM cho OpenClaw với 9Router<br/>by <a href="https://www.youtube.com/c/M%C3%ACAIblog">Mì AI</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://youtu.be/VQAw612S27Y">
        <img src="https://img.youtube.com/vi/VQAw612S27Y/maxresdefault.jpg" alt="9Router + Claude Code FREE Unlimited Setup" width="300"/>
      </a><br/>
      <b>🇵🇰 اردو / हिन्दी</b><br/>
      <sub>9Router + Claude Code FREE Unlimited Setup<br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=raEyZPg5xE0">
        <img src="https://img.youtube.com/vi/raEyZPg5xE0/maxresdefault.jpg" alt="9Router Setup Tutorial" width="300"/>
      </a><br/>
      <b>🇺🇸 English</b><br/>
      <sub>9Router + Claude Code FREE Setup<br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://youtu.be/3dF5GIYMrcQ?si=bAyfyiHbARJQAHj_">
        <img src="https://img.youtube.com/vi/3dF5GIYMrcQ/hqdefault.jpg" alt="9Router Setup Tutorial" width="300"/>
      </a><br/>
      <b>🇺🇸 English</b><br/>
      <sub>9Router + Claude Code FREE Setup<br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=o3qYCyjrFYg">
        <img src="https://img.youtube.com/vi/o3qYCyjrFYg/maxresdefault.jpg" alt="Claude Code FREE Forever" width="300"/>
      </a><br/>
      <b>🇺🇸 English</b><br/>
      <sub>Claude Code FREE Forever — Unlimited Models<br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=Ttpc26m39Dw">
        <img src="https://img.youtube.com/vi/Ttpc26m39Dw/maxresdefault.jpg" alt="Claude CLI Free Setup" width="300"/>
      </a><br/>
      <b>🇺🇸 English</b><br/>
      <sub>Claude CLI Free Setup with 9Router 🚀<br/>by <a href="https://www.youtube.com/@CodeVerseSoban">CodeVerse Soban</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=G-5A_D5Pm6Y">
        <img src="https://img.youtube.com/vi/G-5A_D5Pm6Y/maxresdefault.jpg" alt="Cài đặt OpenClaw Free A-Z" width="300"/>
      </a><br/>
      <b>🇻🇳 Tiếng Việt</b><br/>
      <sub>Cài Đặt OpenClaw Free Từ A-Z + 9Router<br/>by <a href="https://www.youtube.com/@maigia">Mai Gia</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=JXmg8_gccgE">
        <img src="https://img.youtube.com/vi/JXmg8_gccgE/maxresdefault.jpg" alt="FREE OpenClaw with Claude Opus" width="300"/>
      </a><br/>
      <b>🇺🇸 English</b><br/>
      <sub>FREE OpenClaw + Claude Opus 4.6<br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=CkVZZUSTXAI">
        <img src="https://img.youtube.com/vi/CkVZZUSTXAI/mqdefault.jpg" alt="Claude CLI Free Setup" width="300"/>
      </a><br/>
      <b>🇮🇩 Indonesia</b><br/>
      <sub>Koding 24 Jam Anti Rate Limit! Hemat Token AI 65% | Tutorial Quick Setup 9Router 🚀<br/>by <a href="https://www.youtube.com/@krisswuh">Krisswuh</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=TXGv4eofe1I">
        <img src="https://img.youtube.com/vi/TXGv4eofe1I/mqdefault.jpg" alt="Cara Deploy 9Router di Hugging Face GRATIS Non-Stop! | Alternatif VPS RAM 16GB" width="300"/>
      </a><br/>
      <b>🇮🇩 Indonesia</b><br/>
      <sub>Cara Deploy 9Router di Hugging Face GRATIS Non-Stop! | Alternatif VPS RAM 16GB<br/>by <a href="https://www.youtube.com/@krisswuh">Krisswuh</a></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=GyX-DLvePW8">
        <img src="https://img.youtube.com/vi/GyX-DLvePW8/hqdefault.jpg" alt="این شکلی از هر API ای استفاده کن برای هوش مصنوعی" width="300"/>
      </a><br/>
      <b>🇮🇷 Persian-فارسی</b><br/>
      <sub dir="rtl">این شکلی از هر API ای استفاده کن برای هوش مصنوعی<br/>by <a href="https://www.youtube.com/@Matin_SenPai">Matin SenPai</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=hPusYX-5Pmw">
        <img src="https://img.youtube.com/vi/hPusYX-5Pmw/maxresdefault.jpg" alt="Hướng Dẫn Setup OpenClaw + 9Router: Tạo Bot Zalo AI Tự Động Từ A-Z" width="300"/>
      </a><br/>
      <b>🇻🇳 Tiếng Việt</b><br/>
      <sub>Hướng Dẫn Setup OpenClaw + 9Router: Tạo Bot Zalo AI Tự Động Từ A-Z<br/>by <a href="https://github.com/tuanminhhole">tuanminhhole</a></sub>
    </td>
    <td align="center" width="320">
      <a href="https://www.youtube.com/watch?v=hgnE7MKi3Y4">
        <img src="https://img.youtube.com/vi/hgnE7MKi3Y4/maxresdefault.jpg" alt="Bye Limit! Cara Bikin Sistem 'AI Unlimited' 100% Gratis Dengan 9Router!
" width="300"/>
      </a><br/>
      <b>🇮🇩 Indonesia</b><br/>
      <sub>Bye Limit! Cara Bikin Sistem "AI Unlimited" 100% Gratis Dengan 9Router!<br/>by <a href="https://www.youtube.com/@neptiver">neptiver</a></sub>
    </td>
    <td align="center" width="320"></td>
    <td align="center" width="320"></td>
  </tr>
</table>

</div>

> 💡 **Community Guides:** These video walkthroughs demonstrate setup workflows that remain fully compatible with KhatamRouter.

---

## 🛠️ Supported CLI Tools

KhatamRouter works seamlessly with all major AI coding tools:

<div align="center">
  <table>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/claude.png" width="60" alt="Claude Code"/><br/>
        <b>Claude-Code</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/openclaw.png" width="60" alt="OpenClaw"/><br/>
        <b>OpenClaw</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/codex.png" width="60" alt="Codex"/><br/>
        <b>Codex</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/opencode.png" width="60" alt="OpenCode"/><br/>
        <b>OpenCode</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/cursor.png" width="60" alt="Cursor"/><br/>
        <b>Cursor</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/antigravity.png" width="60" alt="Antigravity"/><br/>
        <b>Antigravity</b>
      </td>
    </tr>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/cline.png" width="60" alt="Cline"/><br/>
        <b>Cline</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/continue.png" width="60" alt="Continue"/><br/>
        <b>Continue</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/droid.png" width="60" alt="Droid"/><br/>
        <b>Droid</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/roo.png" width="60" alt="Roo"/><br/>
        <b>Roo</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/copilot.png" width="60" alt="Copilot"/><br/>
        <b>Copilot</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/kilocode.png" width="60" alt="Kilo Code"/><br/>
        <b>Kilo Code</b>
      </td>
    </tr>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/opendesign.png" width="60" alt="OpenDesign"/><br/>
        <b>OpenDesign</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/jcode.png" width="60" alt="jcode"/><br/>
        <b>jcode</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/grok-cli.png" width="60" alt="Grok Build"/><br/>
        <b>Grok Build</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/devin-cli.png" width="60" alt="Devin CLI"/><br/>
        <b>Devin CLI</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/deepseek-tui.png" width="60" alt="DeepSeek TUI"/><br/>
        <b>DeepSeek TUI</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/qwen.png" width="60" alt="Qwen Code"/><br/>
        <b>Qwen Code</b>
      </td>
    </tr>
  </table>
</div>

---

## 🌐 Supported Providers

### 🔐 OAuth Providers

<div align="center">
  <table>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/claude.png" width="60" alt="Claude Code"/><br/>
        <b>Claude-Code</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/antigravity.png" width="60" alt="Antigravity"/><br/>
        <b>Antigravity</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/codex.png" width="60" alt="Codex"/><br/>
        <b>Codex</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/github.png" width="60" alt="GitHub"/><br/>
        <b>GitHub</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/cursor.png" width="60" alt="Cursor"/><br/>
        <b>Cursor</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/kimchi.png" width="60" alt="Kimchi"/><br/>
        <b>Kimchi</b>
      </td>
    </tr>
  </table>
</div>

### 🆓 Free Providers

<div align="center">
  <table>
    <tr>
      <td align="center" width="150">
        <img src="./public/providers/kiro.png" width="70" alt="Kiro"/><br/>
        <b>Kiro AI</b><br/>
        <sub>Claude 4.5 + GLM-5 + MiniMax<br/>50 credits/month free</sub>
      </td>
      <td align="center" width="150">
        <img src="./public/providers/opencode.png" width="70" alt="OpenCode Free"/><br/>
        <b>OpenCode Free</b><br/>
        <sub>No auth • Auto-fetch models<br/>Free (model list varies)</sub>
      </td>
      <td align="center" width="150">
        <img src="./public/providers/gemini.png" width="70" alt="Vertex AI"/><br/>
        <b>Vertex AI</b><br/>
        <sub>Gemini 3 Pro + GLM-5 + DeepSeek<br/>$300 credits free</sub>
      </td>
    </tr>
  </table>
</div>

> **Note:** iFlow, Qwen Code and Gemini CLI free tiers were discontinued in 2026. Use Kiro / OpenCode Free / Vertex instead.
>
> **Kiro AI** moved to a paid model in Sep 2025 — the free tier is now capped at **50 credits/month** (plus 500 trial credits for new accounts in the first 30 days). Paid tiers: Pro $20/mo (1,000 credits), Pro+ $40/mo (2,000), Pro Max $100/mo (5,000), Power $200/mo (10,000).
> **OpenCode Free** model list fluctuates over time (some models free only for limited promos) — subject to change without notice.
> **Vertex AI**: the $300 free credit for new GCP accounts is still valid, but since Mar 2026 the **Gemini API endpoint no longer consumes these credits** — call the **Vertex AI Studio** endpoint instead.

### 🔑 API Key Providers (40+)

<div align="center">
  <table>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/openrouter.png" width="50" alt="OpenRouter"/><br/>
        <sub>OpenRouter</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/glm.png" width="50" alt="GLM"/><br/>
        <sub>GLM</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/kimi.png" width="50" alt="Kimi"/><br/>
        <sub>Kimi</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/minimax.png" width="50" alt="MiniMax"/><br/>
        <sub>MiniMax</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/openai.png" width="50" alt="OpenAI"/><br/>
        <sub>OpenAI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/anthropic.png" width="50" alt="Anthropic"/><br/>
        <sub>Anthropic</sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/gemini.png" width="50" alt="Gemini"/><br/>
        <sub>Gemini</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/deepseek.png" width="50" alt="DeepSeek"/><br/>
        <sub>DeepSeek</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/groq.png" width="50" alt="Groq"/><br/>
        <sub>Groq</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/xai.png" width="50" alt="xAI"/><br/>
        <sub>xAI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/mistral.png" width="50" alt="Mistral"/><br/>
        <sub>Mistral</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/perplexity.png" width="50" alt="Perplexity"/><br/>
        <sub>Perplexity</sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/together.png" width="50" alt="Together"/><br/>
        <sub>Together AI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/fireworks.png" width="50" alt="Fireworks"/><br/>
        <sub>Fireworks</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/cerebras.png" width="50" alt="Cerebras"/><br/>
        <sub>Cerebras</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/cohere.png" width="50" alt="Cohere"/><br/>
        <sub>Cohere</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/nvidia.png" width="50" alt="NVIDIA"/><br/>
        <sub>NVIDIA</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/siliconflow.png" width="50" alt="SiliconFlow"/><br/>
        <sub>SiliconFlow</sub>
      </td>
    </tr>
  </table>
  <p><i>...and 20+ more providers including Nebius, Chutes, Hyperbolic, and custom OpenAI/Anthropic compatible endpoints</i></p>
</div>

### 🏠 Self-hosted Providers

For speech and embeddings served from **your own** machine — whisper.cpp,
faster-whisper, Speaches, Kokoro-FastAPI, openedai-speech, llama.cpp/llama-server,
vLLM, Infinity, text-embeddings-inference, or anything else that speaks the OpenAI
shape.

| Provider | Endpoint used | Typical server |
| --- | --- | --- |
| **Self-hosted STT** | `/v1/audio/transcriptions` | whisper.cpp, faster-whisper |
| **Self-hosted TTS** | `/v1/audio/speech` | Kokoro-FastAPI, openedai-speech |
| **Self-hosted Embedding** | `/v1/embeddings` | llama-server, vLLM, Infinity |

Every other speech provider is a named cloud service with a fixed endpoint. These
three read their address from **each connection**, so one provider can front
several machines and load-balance across them like any other.

Set it on the connection as `providerSpecificData.baseUrl`:

| Provider | Give it | Result |
| --- | --- | --- |
| Self-hosted STT | the full URL — `http://host:8080/v1/audio/transcriptions` | used as-is |
| Self-hosted TTS | the server root — `http://host:8880` | `+ /v1/audio/speech` |
| Self-hosted Embedding | the **OpenAI base**, `/v1` included — `http://host:8080/v1` | `+ /embeddings` |

> **Mind the `/v1` on embeddings.** The adapter appends `/embeddings`, so
> `http://host:8080` resolves to `http://host:8080/embeddings` and misses the
> OpenAI route — llama-server answers **501**. Give it the same base URL an OpenAI
> client would use. A full `.../v1/embeddings` is also accepted, so a value pasted
> from a `curl` example works too.

The API key is not checked by most local servers, but the field must be non-empty:
it is what gives the connection a credentials record, and `baseUrl` lives there.
Any placeholder works.

Self-hosted Embedding has **no cloud fallback by design** — a connection saved
without a `baseUrl` is reported as a configuration error rather than quietly
falling back to `api.openai.com`, which would send your input text and API key to
a third party under a provider named "Self-hosted".

---

## 💡 Key Features

| Feature                                                                           | What It Does                                                                             | Why It Matters                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 🚀 **RTK Token Saver** ([RTK](https://github.com/rtk-ai/rtk) ⭐40K)               | Compress tool outputs (`git diff`, `grep`, `ls`, `tree`...) before sending to LLM        | Save **20-40% input tokens** per request          |
| 🧠 **Headroom Token Saver** ([Headroom](https://github.com/chopratejas/headroom)) | Optional external `/v1/compress` proxy before provider routing                           | Save more context tokens without changing clients |
| 🪨 **Caveman Mode** ([Caveman](https://github.com/JuliusBrussee/caveman) ⭐52K)   | Inject caveman-speak prompt → LLM replies terse, technical substance preserved           | Save **up to 65% output tokens**                  |
| 🐴 **Ponytail** ([Ponytail](https://github.com/DietrichGebert/ponytail))          | Inject "lazy senior dev" prompt → LLM writes minimal, YAGNI-first code (Lite/Full/Ultra) | **Fewer output tokens, less refactoring**         |
| 🎯 **Smart 3-Tier Fallback**                                                      | Auto-route: Subscription → Cheap → Free                                                  | Never stop coding, zero downtime                  |
| 📊 **Real-Time Quota Tracking**                                                   | Live token count + reset countdown                                                       | Maximize subscription value                       |
| 🔄 **Format Translation**                                                         | OpenAI ↔ Claude ↔ Gemini ↔ Cursor ↔ Kiro ↔ Vertex                                        | Works with any CLI tool                           |
| 👥 **Multi-Account Support**                                                      | Multiple accounts per provider                                                           | Load balancing + redundancy                       |
| 🔄 **Auto Token Refresh**                                                         | OAuth tokens refresh automatically                                                       | No manual re-login needed                         |
| 🎨 **Custom Combos**                                                              | Create unlimited model combinations                                                      | Tailor fallback to your needs                     |
| 📝 **Request Logging**                                                            | Debug mode with full request/response logs                                               | Troubleshoot issues easily                        |
| 💾 **Cloud Sync**                                                                 | Sync config across devices                                                               | Same setup everywhere                             |
| 📊 **Usage Analytics**                                                            | Track tokens, cost, trends over time                                                     | Optimize spending                                 |
| 🌐 **Deploy Anywhere**                                                            | Localhost, VPS, Docker, Cloudflare Workers                                               | Flexible deployment options                       |

Set `X-9Router-Token-Saver: off` to bypass all token savers for one chat request. (The header name is kept from upstream for client compatibility.)

<details>
<summary><b>📖 Feature Details</b></summary>

### 🚀 RTK Token Saver

Tool outputs (`git diff`, `grep`, `find`, `ls`, `tree`, log dumps...) often eat 30-50% of your prompt budget. RTK detects them and applies smart, token-reducing compression **before** the request hits the LLM. This is intentionally lossy: each filter truncates very long, low-signal sections (diff hunks capped at 100 lines, repetitive logs deduplicated and capped at 2,000 lines, only the top 3 build deprecations and top 5 warnings kept):

- **Filters:** `git-diff`, `git-status`, `grep`, `find`, `ls`, `tree`, `dedup-log`, `smart-truncate`, `read-numbered`, `search-list`, `build-output`
- **Auto-detect:** No config needed — RTK peeks the first 1KB of each `tool_result` and picks the right filter.
- **Safe by design:** If a filter fails, throws, or makes output bigger, RTK silently keeps the original text. Errors never break your request.
- **Universal:** Works across all formats (OpenAI, Claude, Gemini, Cursor, Kiro, OpenAI Responses) because it runs **before** any format translation.
- **Default ON:** Toggle anytime in Dashboard → Endpoint settings.

```
Without RTK: 47K tokens sent to LLM
With RTK:    28K tokens sent to LLM   (40% saved · same context · same answer — upstream 9Router example figure)
```

### 🧠 Headroom Token Saver

Headroom is optional and runs separately. KhatamRouter calls Headroom's local `/v1/compress` endpoint, then keeps normal routing, fallback, auth, and usage tracking:

```
Client → KhatamRouter → Headroom /v1/compress → KhatamRouter → provider
```

Local setup:

```bash
pip install "headroom-ai[proxy]"
headroom proxy --port 8787
```

Enable in Dashboard → Endpoint → Token Saver → Headroom. Default URL: `http://localhost:8787`.

Docker examples:

```bash
# Headroom service in same Docker network
http://headroom:8787

# Headroom running on host machine
http://host.docker.internal:8787
```

If Headroom is down or returns an error, KhatamRouter fails open and sends the original request.

### 🐴 Ponytail (Lazy Senior Dev)

Ponytail injects a _"lazy senior dev"_ system prompt into every request, biasing the LLM toward minimal, YAGNI-first code — deletion over addition, stdlib over new deps, one-liners over abstractions. Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail).

- **Lite** — Build what's asked, name the lazier alternative.
- **Full** — YAGNI ladder enforced: stdlib → native → existing deps → one-liner → minimal code.
- **Ultra** — YAGNI extremist: deletion first, ship the one-liner, challenge the rest of the requirement in the same response.

```
Without Ponytail: verbose code, extra abstractions, "just in case" scaffolding
With Ponytail:    shortest working diff, no unrequested abstractions, fewer tokens
```

Never trades away: input validation, error handling that prevents data loss, security, accessibility, or anything explicitly requested. Enable in Dashboard → Endpoint → Ponytail. Stacks with Caveman (output terseness) and RTK (input compression).

### 🎯 Smart 3-Tier Fallback

Create combos with automatic fallback:

```
Combo: "my-coding-stack"
  1. cc/claude-opus-4-6        (your subscription)
  2. glm/glm-4.7               (cheap backup, $0.6/1M)
  3. kr/claude-sonnet-4.5      (free fallback)

→ Auto switches when quota runs out or errors occur
```

### 📊 Real-Time Quota Tracking

- Token consumption per provider
- Reset countdown (5-hour, daily, weekly)
- Cost estimation for paid tiers
- Monthly spending reports

### 🔄 Format Translation

Seamless translation between formats:

- **OpenAI** ↔ **Claude** ↔ **Gemini** ↔ **Cursor** ↔ **Kiro** ↔ **Vertex** ↔ **Antigravity** ↔ **Ollama** ↔ **OpenAI Responses**
- Your CLI tool sends OpenAI format → KhatamRouter translates → Provider receives native format
- Works with any tool that supports custom OpenAI endpoints

### 👥 Multi-Account Support

- Add multiple accounts per provider
- Auto round-robin or priority-based routing
- Fallback to next account when one hits quota

### 🔄 Auto Token Refresh

- OAuth tokens automatically refresh before expiration
- No manual re-authentication needed
- Seamless experience across all providers

### 🎨 Custom Combos

- Create unlimited model combinations
- Mix subscription, cheap, and free tiers
- Name your combos for easy access
- Share combos across devices with Cloud Sync

### 📝 Request Logging

- Enable debug mode for full request/response logs
- Track API calls, headers, and payloads
- Troubleshoot integration issues
- Export logs for analysis

### 💾 Cloud Sync

- Sync providers, combos, and settings across devices
- Automatic background sync
- Secure encrypted storage
- Access your setup from anywhere

#### Cloud Runtime Notes

- Prefer server-side cloud variables in production:
  - `BASE_URL` (internal callback URL used by sync scheduler)
  - `CLOUD_URL` (cloud sync endpoint base)
- `NEXT_PUBLIC_BASE_URL` and `NEXT_PUBLIC_CLOUD_URL` are still supported for compatibility/UI, but server runtime now prioritizes `BASE_URL`/`CLOUD_URL`.
- Cloud sync requests now use timeout + fail-fast behavior to avoid UI hanging when cloud DNS/network is unavailable.

### 📊 Usage Analytics

- Track token usage per provider and model
- Cost estimation and spending trends
- Monthly reports and insights
- Optimize your AI spending

> **💡 IMPORTANT - Understanding Dashboard Costs:**
>
> The "cost" displayed in Usage Analytics is **for tracking and comparison purposes only**.
> KhatamRouter itself **never charges** you anything. You only pay providers directly (if using paid services).
>
> **Example:** If your dashboard shows "$290 total cost" while using Kiro free models, this represents
> what you would have paid using paid APIs directly. Your actual cost = **$0** (Kiro free tier: ~50 credits/mo).
>
> Think of it as a "savings tracker" showing how much you're saving by using free models or
> routing through KhatamRouter!

### 🌐 Deploy Anywhere

- 💻 **Localhost** - Default, works offline
- ☁️ **VPS/Cloud** - Share across devices
- 🐳 **Docker** - One-command deployment
- 🚀 **Cloudflare Workers** - Global edge network

</details>

---

## 💰 Pricing at a Glance

| Tier                | Provider              | Cost         | Quota Reset      | Best For                                |
| ------------------- | --------------------- | ------------ | ---------------- | --------------------------------------- |
| **🚀 TOKEN SAVER**  | **RTK (built-in)**    | **FREE**     | Always on        | **Save 20-40% tokens on EVERY request** |
| **💳 SUBSCRIPTION** | Claude Code (Pro/Max) | $20-200/mo   | 5h + weekly      | Already subscribed                      |
|                     | Codex (Plus/Pro)      | $20-200/mo   | 5h + weekly      | OpenAI users                            |
|                     | GitHub Copilot        | $10-19/mo    | Monthly          | GitHub users                            |
|                     | Cursor IDE            | $20/mo       | Monthly          | Cursor users                            |
| **💰 CHEAP**        | GLM-5.1 / GLM-4.7     | $0.6/1M      | Daily 10AM       | Budget backup                           |
|                     | MiniMax M2.7          | $0.2/1M      | 5-hour rolling   | Cheapest option                         |
|                     | Kimi K2.5             | $9/mo flat   | 10M tokens/mo    | Predictable cost                        |
 | **🆓 FREE**         | Kiro AI               | $0           | 50 credits/mo    | Claude 4.5 + GLM-5 + MiniMax free (paid tiers above) |
 |                     | OpenCode Free         | $0           | Varies*          | No auth, auto-fetch models (list changes over time) |
 |                     | Vertex AI             | $300 credits | New GCP accounts | Gemini 3 Pro + DeepSeek + GLM-5 (use Vertex AI Studio endpoint for free credits) |

**💡 Pro Tip:** RTK + Kiro AI + OpenCode Free combo = **$0 cost + 20-40% token savings**!

---

### 📊 Understanding KhatamRouter Costs & Billing

**KhatamRouter Billing Reality:**

✅ **KhatamRouter software = FREE forever** (open source, never charges)  
✅ **Dashboard "costs" = Display/tracking only** (not actual bills)  
✅ **You pay providers directly** (subscriptions or API fees)  
✅ **FREE providers stay FREE** (Kiro ~50 credits/mo, OpenCode Free, Vertex $300 credits = $0 within free-tier limits) — note iFlow/Qwen/Gemini CLI free tiers were discontinued in 2026
❌ **KhatamRouter never sends invoices** or charges your card

**How Cost Display Works:**

The dashboard shows **estimated costs** as if you were using paid APIs directly. This is **not billing** - it's a comparison tool to show your savings.

**Example Scenario:**

```
Dashboard Display:
• Total Requests: 1,662
• Total Tokens: 47M
• Display Cost: $290

Reality Check:
• Provider: Kiro (free tier: ~50 credits/mo)
• Actual Payment: $0.00
• What $290 Means: Amount you SAVED by using free models!
```

**Payment Rules:**

- **Subscription providers** (Claude Code, Codex): Pay them directly via their websites
- **Cheap providers** (GLM, MiniMax): Pay them directly, KhatamRouter just routes
- **FREE providers** (Kiro, OpenCode Free, Vertex credits): Free within tier limits, no hidden charges
- **KhatamRouter**: Never charges anything, ever

---

## 🎯 Use Cases

### Case 1: "I have Claude Pro subscription"

**Problem:** Quota expires unused, rate limits during heavy coding

**Solution:**

```
Combo: "maximize-claude"
  1. cc/claude-opus-4-7        (use subscription fully)
  2. glm/glm-5.1               (cheap backup when quota out)
  3. kr/claude-sonnet-4.5      (free emergency fallback)

Monthly cost: $20 (subscription) + ~$5 (backup) = $25 total
vs. $20 + hitting limits = frustration
```

### Case 2: "I want zero cost"

**Problem:** Can't afford subscriptions, need reliable AI coding

**Solution:**

```
Combo: "free-forever"
  1. kr/claude-sonnet-4.5      (Claude 4.5 free via Kiro, ~50 credits/mo)
  2. kr/glm-5                  (GLM-5 free via Kiro)
  3. oc/<auto>                 (OpenCode Free, no auth)

Monthly cost: $0
Quality: Production-ready models + RTK saves 20-40% tokens
```

### Case 3: "I need 24/7 coding, no interruptions"

**Problem:** Deadlines, can't afford downtime

**Solution:**

```
Combo: "always-on"
  1. cc/claude-opus-4-7        (best quality)
  2. cx/gpt-5.5                (second subscription)
  3. glm/glm-5.1               (cheap, resets daily)
  4. minimax/MiniMax-M2.7      (cheapest, 5h reset)
  5. kr/claude-sonnet-4.5      (free via Kiro, ~50 credits/mo)

Result: 5 layers of fallback = zero downtime
Monthly cost: $20-200 (subscriptions) + $10-20 (backup)
```

### Case 4: "I want FREE AI in OpenClaw"

**Problem:** Need AI assistant in messaging apps (WhatsApp, Telegram, Slack...), completely free

**Solution:**

```
Combo: "openclaw-free"
  1. kr/claude-sonnet-4.5      (Claude 4.5 free)
  2. kr/glm-5                  (GLM-5 free)
  3. kr/MiniMax-M2.5           (MiniMax free)

Monthly cost: $0
Access via: WhatsApp, Telegram, Slack, Discord, iMessage, Signal...
```

---

## ❓ Frequently Asked Questions

<details>
<summary><b>📊 Why does my dashboard show high costs?</b></summary>

The dashboard tracks your token usage and displays **estimated costs** as if you were using paid APIs directly. This is **not actual billing** - it's a reference to show how much you're saving by using free models or existing subscriptions through KhatamRouter.

**Example:**

- **Dashboard shows:** "$290 total cost"
- **Reality:** You're using Kiro free models (~50 credits/mo)
- **Your actual cost:** **$0.00**
- **What $290 means:** Amount you **saved** by using free models instead of paid APIs!

The cost display is a "savings tracker" to help you understand your usage patterns and optimization opportunities.

</details>

<details>
<summary><b>💳 Will I be charged by KhatamRouter?</b></summary>

**No.** KhatamRouter is free, open-source software that runs on your own computer. It never charges you anything.

**You only pay:**

- ✅ **Subscription providers** (Claude Code $20/mo, Codex $20-200/mo) → Pay them directly on their websites
- ✅ **Cheap providers** (GLM, MiniMax) → Pay them directly, KhatamRouter just routes your requests
- ❌ **KhatamRouter itself** → **Never charges anything, ever**

KhatamRouter is a local proxy/router. It doesn't have your credit card, can't send invoices, and has no billing system. It's completely free software.

</details>

<details>
<summary><b>🆓 Are FREE providers really unlimited?</b></summary>

**Mostly!** The current FREE providers (Kiro, OpenCode Free, Vertex) are genuinely free, but free tiers have limits:

These are free services offered by those respective companies:

- **Kiro AI**: ~50 credits/month free (plus 500 trial credits for new accounts in the first 30 days) via AWS Builder ID / Google / GitHub OAuth. Paid tiers available above that.
- **OpenCode Free**: No-auth passthrough proxy, models auto-fetched from `opencode.ai/zen/v1/models`. The free model list fluctuates over time (some models free only for limited promos) — subject to change without notice.
- **Vertex AI**: $300 free credits for new Google Cloud accounts (90 days). Since Mar 2026 the Gemini API endpoint no longer consumes these credits — use the **Vertex AI Studio** endpoint instead.

KhatamRouter just routes your requests to them - there's no "catch" or future billing from KhatamRouter itself. They're truly free services, and KhatamRouter makes them easy to use with fallback support.

**Discontinued free tiers (no longer recommended):**

- ❌ **iFlow**: Was free unlimited, now changed to paid (2026)
- ❌ **Qwen Code**: Free OAuth tier fully discontinued by Alibaba on 2026-04-15
- ❌ **Gemini CLI**: Service fully shut down by Google on 2026-06-18 (replaced by the closed-source Antigravity CLI). Discontinued — do not use.

</details>

<details>
<summary><b>💰 How do I minimize my actual AI costs?</b></summary>

**Free-First Strategy:**

1. **Start with 100% free combo:**

   ```
   1. kr/glm-5 (GLM-5 free via Kiro, ~50 credits/mo)
   2. OpenCode Free models (no auth, auto-fetched)
   3. Vertex AI Gemini 3 Pro (using the Vertex AI Studio endpoint with $300 credits)
   ```

   **Cost: $0/month** (within Kiro's free credit cap; OpenCode/Vertex subject to their free-tier limits)

2. **Add cheap backup** only if you need it:

   ```
   4. glm/glm-4.7 ($0.6/1M tokens)
   ```

   **Additional cost: Only pay for what you actually use**

3. **Use subscription providers last:**
   - Only if you already have them
   - KhatamRouter helps maximize their value through quota tracking

**Result:** Most users can operate at $0/month using only free tiers!

</details>

<details>
<summary><b>📈 What if my usage suddenly spikes?</b></summary>

KhatamRouter's smart fallback prevents surprise charges:

**Scenario:** You're on a coding sprint and blow through your quotas

**Without KhatamRouter:**

- ❌ Hit rate limit → Work stops → Frustration
- ❌ Or: Accidentally rack up huge API bills

**With KhatamRouter:**

- ✅ Subscription hits limit → Auto-fallback to cheap tier
- ✅ Cheap tier gets expensive → Auto-fallback to free tier
- ✅ Never stop coding → Predictable costs

**You're in control:** Set spending limits per provider in dashboard, and KhatamRouter respects them.

</details>

---

## 📖 Setup Guide

<details>
<summary><b>🔐 Subscription Providers (Maximize Value)</b></summary>

### Claude Code (Pro/Max)

```bash
Dashboard → Providers → Connect Claude Code
→ OAuth login → Auto token refresh
→ 5-hour + weekly quota tracking

Models:
  cc/claude-opus-4-7
  cc/claude-opus-4-6
  cc/claude-sonnet-4-6
  cc/claude-haiku-4-5-20251001
```

**Pro Tip:** Use Opus for complex tasks, Sonnet for speed. KhatamRouter tracks quota per model!

### OpenAI Codex (Plus/Pro)

```bash
Dashboard → Providers → Connect Codex
→ OAuth login (port 1455)
→ 5-hour + weekly reset

Models:
  cx/gpt-5.5
  cx/gpt-5.4
  cx/gpt-5.3-codex
  cx/gpt-5.2-codex
```

### GitHub Copilot

```bash
Dashboard → Providers → Connect GitHub
→ OAuth via GitHub
→ Monthly reset (1st of month)

Models:
  gh/gpt-5.4
  gh/claude-opus-4.7
  gh/claude-sonnet-4.6
  gh/gemini-3.1-pro-preview
  gh/grok-code-fast-1
```

### Cursor IDE

```bash
Dashboard → Providers → Connect Cursor
→ OAuth login
→ Monthly subscription

Models:
  cu/claude-4.6-opus-max
  cu/claude-4.5-sonnet-thinking
  cu/gpt-5.3-codex
```

</details>

<details>
<summary><b>💰 Cheap Providers (Backup)</b></summary>

### GLM-5.1 / GLM-4.7 (Daily reset, $0.6/1M)

1. Sign up: [Zhipu AI](https://open.bigmodel.cn/)
2. Get API key from Coding Plan
3. Dashboard → Add API Key:
   - Provider: `glm`
   - API Key: `your-key`

**Use:** `glm/glm-5.1`, `glm/glm-5`, `glm/glm-4.7`

**Pro Tip:** Coding Plan offers 3× quota at 1/7 cost! Reset daily 10:00 AM.

### MiniMax M2.7 (5h reset, $0.20/1M)

1. Sign up: [MiniMax](https://www.minimax.io/)
2. Get API key
3. Dashboard → Add API Key

**Use:** `minimax/MiniMax-M2.7`, `minimax/MiniMax-M2.5`

**Pro Tip:** Cheapest option for long context (1M tokens)!

### Kimi K2.5 ($9/month flat)

1. Subscribe: [Moonshot AI](https://platform.moonshot.ai/)
2. Get API key
3. Dashboard → Add API Key

**Use:** `kimi/kimi-k2.5`, `kimi/kimi-k2.5-thinking`

**Pro Tip:** Fixed $9/month for 10M tokens = $0.90/1M effective cost!

</details>

<details>
<summary><b>🆓 FREE Providers (Recommended)</b></summary>

### Kiro AI (Claude 4.5 + GLM-5 + MiniMax FREE)

```bash
Dashboard → Connect Kiro
→ AWS Builder ID, AWS IAM Identity Center, Google, or GitHub
→ Unlimited usage

Models:
  kr/claude-sonnet-4.5
  kr/claude-haiku-4.5
  kr/glm-5
  kr/MiniMax-M2.5
  kr/qwen3-coder-next
  kr/deepseek-3.2
```

**Pro Tip:** Best free option for Claude. No API key, no payment, fully unlimited.

### OpenCode Free (No auth, auto-fetch models)

```bash
Dashboard → Connect OpenCode Free
→ No login required (passthrough proxy)
→ Models auto-fetched from opencode.ai/zen/v1/models
```

**Pro Tip:** Fastest setup. Just connect and start coding.

### Vertex AI ($300 free credits for new GCP accounts)

```bash
Dashboard → Connect Vertex AI
→ Upload Google Cloud Service Account JSON
→ Enable Vertex AI API in your GCP project

Models:
  vertex/gemini-3.1-pro-preview
  vertex/gemini-3-flash-preview
  vertex/gemini-2.5-flash

Vertex Partner (Anthropic / DeepSeek / GLM / Qwen via Vertex):
  vertex-partner/glm-5-maas
  vertex-partner/deepseek-v3.2-maas
  vertex-partner/qwen3-next-80b-a3b-thinking-maas
```

For a raw Google Cloud API-key connection, set the following through
`PUT /api/providers/<connection-id>` to select the global endpoint:

```json
{
  "providerSpecificData": {
    "projectId": "YOUR_GOOGLE_CLOUD_PROJECT_ID",
    "location": "global"
  }
}
```

With an explicit project, API-key requests honor `location` and default to
`global` when it is omitted. Connections without an explicit project retain
the projectless endpoint. Gemini 4 Argon supports `global`, `us`, and `eu`,
not regional locations such as `europe-west1`; see
[Google's supported locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon).

**Pro Tip:** New Google Cloud accounts get $300 credits free for 90 days. Plenty for daily coding.

</details>

<details>
<summary><b>🎨 Create Combos</b></summary>

### Example 1: Maximize Subscription → Cheap Backup

```
Dashboard → Combos → Create New

Name: premium-coding
Models:
  1. cc/claude-opus-4-7 (Subscription primary)
  2. glm/glm-5.1 (Cheap backup, $0.6/1M)
  3. minimax/MiniMax-M2.7 (Cheapest fallback, $0.20/1M)

Use in CLI: premium-coding

Monthly cost example (100M tokens):
  80M via Claude (subscription): $0 extra
  15M via GLM: $9
  5M via MiniMax: $1
  Total: $10 + your subscription
```

### Example 2: Free-Only (Zero Cost)

```
Name: free-combo
Models:
  1. kr/claude-sonnet-4.5 (Claude 4.5 free via Kiro, ~50 credits/mo)
  2. kr/glm-5 (GLM-5 free via Kiro)
  3. vertex/gemini-3.1-pro-preview ($300 free credits)

Cost: $0 forever (+ 20-40% token savings via RTK)!
```

</details>

<details>
<summary><b>🔧 CLI Integration</b></summary>

### Cursor IDE

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from KhatamRouter dashboard]
  Model: cc/claude-opus-4-7
```

Or use combo: `premium-coding`

### Claude Code

Edit `~/.claude/config.json`:

```json
{
  "anthropic_api_base": "http://localhost:20128/v1",
  "anthropic_api_key": "your-khatamrouter-api-key"
}
```

### Codex CLI

```bash
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="your-khatamrouter-api-key"

codex "your prompt"
```

### OpenClaw

**Option 1 — Dashboard (recommended):**

```
Dashboard → CLI Tools → OpenClaw → Select Model → Apply
```

**Option 2 — Manual:** Edit `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "khatamrouter/kr/claude-sonnet-4.5"
      }
    }
  },
  "models": {
    "providers": {
      "khatamrouter": {
        "baseUrl": "http://127.0.0.1:20128/v1",
        "apiKey": "sk_9router",
        "api": "openai-completions",
        "models": [
          {
            "id": "kr/claude-sonnet-4.5",
            "name": "Claude Sonnet 4.5 (Kiro Free)"
          }
        ]
      }
    }
  }
}
```

> **Note:** Upstream `9router` provider blocks and `sk_9router` key formats remain fully supported. OpenClaw connects locally, so use `127.0.0.1` instead of `localhost` to avoid IPv6 loopback resolution issues.

### Cline / Continue / RooCode

```
Provider: OpenAI Compatible
Base URL: http://localhost:20128/v1
API Key: [from KhatamRouter dashboard]
Model: cc/claude-opus-4-7
```

</details>

<details>
<summary><b>🚀 Deployment</b></summary>

### VPS Deployment (Bun Required)

```bash
# Clone and install (Bun strictly required)
git clone https://github.com/rqzbeh/KhatamRouter.git
cd KhatamRouter
bun install
bun run build:bun

# Configure
export JWT_SECRET="your-secure-secret-change-this"
export INITIAL_PASSWORD="your-password"
export DATA_DIR="/var/lib/khatamrouter"
export DASHBOARD_PORT="20128"
export PORT="20128"
export HOSTNAME="0.0.0.0"
export NODE_ENV="production"
export NEXT_PUBLIC_BASE_URL="http://localhost:20128"
export API_KEY_SECRET="endpoint-proxy-api-key-secret"
export MACHINE_ID_SALT="endpoint-proxy-salt"
export REDIS_URL="redis://127.0.0.1:6379"

# Start with Bun
PORT=20128 HOSTNAME=0.0.0.0 bun run start:bun
```

### Docker Compose (Recommended Default Stack)

KhatamRouter provides a default `docker-compose.yml` that builds from `Dockerfile.bun` and launches alongside `redis:8.2-alpine` with healthchecks and AOF persistence:

```bash
docker compose up -d
```

- **Redis**: Runs `redis:8.2-alpine` with AOF on volume `redis-data`, bound strictly to `127.0.0.1:6379`.
- **Healthcheck**: Tested via `redis-cli ping` every 5 seconds.
- **Disabling Redis**: Set `REDIS_URL` empty or comment out the `redis` service in `docker-compose.yml`. KhatamRouter will degrade cleanly to standalone `bun:sqlite` with in-memory coordination.

### Docker Standalone

Published image (multi-platform `linux/amd64` + `linux/arm64`), built from `Dockerfile.bun`:

- GHCR: [`ghcr.io/rqzbeh/khatamrouter`](https://github.com/users/rqzbeh/packages)

**Quick start (use published image):**

```bash
docker run -d \
  --name khatamrouter \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  ghcr.io/rqzbeh/khatamrouter:latest
```

→ Dashboard: http://localhost:20128 · API gateway: http://localhost:20128/v1

**Build from source (dev):**

```bash
git clone https://github.com/rqzbeh/KhatamRouter.git
cd KhatamRouter
docker build -f Dockerfile -t khatamrouter .
docker run -d --name khatamrouter -p 20128:20128 \
  -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data khatamrouter
```

*(To build with native Bun runtime instead, use `docker build -f Dockerfile.bun -t khatamrouter .`)*

**Container defaults:**

- `DASHBOARD_PORT=20128` (control plane / dashboard and `/v1` gateway)
- `HOSTNAME=0.0.0.0`

**Useful commands:**

```bash
docker logs -f khatamrouter
docker restart khatamrouter
docker stop khatamrouter && docker rm khatamrouter
docker pull ghcr.io/rqzbeh/khatamrouter:latest   # update to latest
```

**Data persistence:** `$HOME/.9router/db/data.sqlite` on host ↔ `/app/data/db/data.sqlite` in container.

### Environment Variables

| Variable                                             | Default                                  | Description                                                                         |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `JWT_SECRET`                                         | Auto-generated (`~/.9router/jwt-secret`) | JWT signing secret for dashboard auth cookie (override to share across instances)   |
| `INITIAL_PASSWORD`                                   | `123456`                                 | First login password when no saved hash exists                                      |
| `DATA_DIR`                                           | `~/.9router`                             | Main app data location (SQLite at `$DATA_DIR/db/data.sqlite`)                       |
| `DASHBOARD_PORT`                                     | `20128`                                  | Control-plane dashboard and API gateway port (Bun + Next.js)                        |
| `PORT`                                               | framework default                        | Backward-compatible alias for `DASHBOARD_PORT` (`20128` in examples)                |
| `KHATAM_WORKERS`                                     | `auto` (`Math.max(1, nproc - 2)`)        | Vertical scale: worker processes on one host. `1` = legacy single process (see [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md)) |
| `WEB_CONCURRENCY`                                    | unset                                    | Fallback for `KHATAM_WORKERS` when that is unset                                    |
| `KHATAM_DRAIN_TIMEOUT_MS`                            | `30000`                                  | Vertical scale: time a worker waits for in-flight streams after `SIGTERM`           |
| `KHATAM_CRASH_RESET_MS`                              | `30000`                                  | Vertical scale: uptime after which a worker's crash counter resets                  |
| `HOSTNAME`                                           | framework default                        | Bind host (Docker defaults to `0.0.0.0`)                                            |
| `NODE_ENV`                                           | runtime default                          | Set `production` for deploy                                                         |
| `REDIS_URL`                                          | empty                                    | Optional Redis URL; unset means SQLite-only fallback (no Redis required)            |
| `REDIS_KEY_PREFIX`                                   | `khatam:`                                | Key/channel namespace for Redis rate limits, quotas, breakers and pub/sub           |
| `BASE_URL`                                           | `http://localhost:20128`                 | Server-side internal base URL used by cloud sync jobs                               |
| `CLOUD_URL`                                          | optional                                 | Server-side cloud sync endpoint base URL (set if using cloud sync server)           |
| `NEXT_PUBLIC_BASE_URL`                               | `http://localhost:20128`                 | Backward-compatible/public base URL (prefer `BASE_URL` for server runtime)          |
| `NEXT_PUBLIC_CLOUD_URL`                              | optional                                 | Backward-compatible/public cloud URL (prefer `CLOUD_URL` for server runtime)        |
| `API_KEY_SECRET`                                     | `endpoint-proxy-api-key-secret`          | HMAC secret for generated API keys                                                  |
| `MACHINE_ID_SALT`                                    | `endpoint-proxy-salt`                    | Salt for stable machine ID hashing                                                  |
| `ENABLE_REQUEST_LOGS`                                | `false`                                  | Enables request/response logs under `logs/`                                         |
| `AUTH_COOKIE_SECURE`                                 | `false`                                  | Force `Secure` auth cookie (set `true` behind HTTPS reverse proxy)                  |
| `REQUIRE_API_KEY`                                    | `false`                                  | Enforce Bearer API key on `/v1/*` routes (recommended for internet-exposed deploys) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | empty                                    | Optional outbound proxy for upstream provider calls                                 |
| `SEARXNG_URL`                                        | `http://localhost:8888/search`           | Endpoint for the built-in unauthenticated SearXNG web-search provider               |

Notes:

- Lowercase proxy variables are also supported: `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`.
- `.env` is not baked into Docker image (`.dockerignore`); inject runtime config with `--env-file` or `-e`.
- On Windows, `APPDATA` can be used for local storage path resolution.
- `INSTANCE_NAME` appears in older docs/env templates, but is currently not used at runtime.

### Runtime Files and Storage

- Main app state: `${DATA_DIR}/db/data.sqlite` (SQLite — providers, combos, aliases, keys, settings, usage history)
- Auto backups: `${DATA_DIR}/db/backups/`
- Optional request/translator logs: `<repo>/logs/...` when `ENABLE_REQUEST_LOGS=true`
- Both `${DATA_DIR}` and `~/.9router` resolve to the same location in a Docker container — the symlink `/root/.9router -> /app/data` is created at build time.

</details>

---

## 📊 Available Models

<details>
<summary><b>View all available models</b></summary>

**Claude Code (`cc/`)** - Pro/Max:

- `cc/claude-opus-4-7`
- `cc/claude-opus-4-6`
- `cc/claude-sonnet-4-6`
- `cc/claude-sonnet-4-5-20250929`
- `cc/claude-haiku-4-5-20251001`

**Codex (`cx/`)** - Plus/Pro:

- `cx/gpt-5.5`
- `cx/gpt-5.4`
- `cx/gpt-5.3-codex`
- `cx/gpt-5.2-codex`
- `cx/gpt-5.1-codex-max`

**GitHub Copilot (`gh/`)**:

- `gh/gpt-5.4`
- `gh/claude-opus-4.7`
- `gh/claude-sonnet-4.6`
- `gh/gemini-3.1-pro-preview`
- `gh/grok-code-fast-1`

**Cursor (`cu/`)** - Subscription:

- `cu/claude-4.6-opus-max`
- `cu/claude-4.5-sonnet-thinking`
- `cu/gpt-5.3-codex`
- `cu/kimi-k2.5`

**GLM (`glm/`)** - $0.6/1M:

- `glm/glm-5.1`
- `glm/glm-5`
- `glm/glm-4.7`

**MiniMax (`minimax/`)** - $0.2/1M:

- `minimax/MiniMax-M2.7`
- `minimax/MiniMax-M2.5`

**Kimi (`kimi/`)** - $9/mo flat:

- `kimi/kimi-k2.5`
- `kimi/kimi-k2.5-thinking`

**Kiro (`kr/`)** - Free (~50 credits/month, paid tiers above):

- `kr/claude-sonnet-4.5`
- `kr/claude-haiku-4.5`
- `kr/glm-5`
- `kr/MiniMax-M2.5`
- `kr/qwen3-coder-next`
- `kr/deepseek-3.2`

**OpenCode Free (`oc/`)** - FREE no-auth:

- Auto-fetched from `opencode.ai/zen/v1/models`

**Vertex AI (`vertex/`)** - $300 free credits:

- `vertex/gemini-3.1-pro-preview`
- `vertex/gemini-3-flash-preview`
- `vertex/gemini-2.5-flash`
- `vertex-partner/glm-5-maas`
- `vertex-partner/deepseek-v3.2-maas`

</details>

---

## 🐛 Troubleshooting

**"Language model did not provide messages"**

- Provider quota exhausted → Check dashboard quota tracker
- Solution: Use combo fallback or switch to cheaper tier

**Rate limiting**

- Subscription quota out → Fallback to GLM/MiniMax
- Add combo: `cc/claude-opus-4-7 → glm/glm-5.1 → kr/claude-sonnet-4.5`

**OAuth token expired**

- Auto-refreshed by KhatamRouter
- If issues persist: Dashboard → Provider → Reconnect

**High costs**

- Enable RTK in Dashboard → Endpoint settings (default ON, saves 20-40% tokens)
- Check usage stats in Dashboard
- Switch primary model to GLM/MiniMax
- Use free tier (Kiro, OpenCode Free, Vertex) for non-critical tasks

**Dashboard opens on wrong port**

- Set `PORT=20128` and `NEXT_PUBLIC_BASE_URL=http://localhost:20128`

**First login not working**

- Check `INITIAL_PASSWORD` in `.env`
- If unset, fallback password is `123456`

**No request logs under `logs/`**

- Set `ENABLE_REQUEST_LOGS=true`

---

## 🛠️ Tech Stack

- **Runtime**: Bun v1.4.3+ strictly required (Node.js is not supported)
- **Language**: JavaScript (ESM, `@/*` → `src/*`)
- **Framework**: Next.js 16 (Webpack bundler)
- **UI**: React 19 + Tailwind CSS 4
- **Database**: SQLite in WAL mode strictly via `bun:sqlite` (`$DATA_DIR/db/data.sqlite`)
- **Acceleration & Cache**: Redis (`redis:8.2-alpine` by default in docker compose) under `khatam:` namespace, fail-safe degradation to SQLite
- **Streaming**: Server-Sent Events (SSE)
- **Auth**: OAuth 2.0 (PKCE) + JWT + API Keys

---

## 📝 API Reference

### Chat Completions

```bash
POST http://localhost:20128/v1/chat/completions
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "model": "cc/claude-opus-4-6",
  "messages": [
    {"role": "user", "content": "Write a function to..."}
  ],
  "stream": true
}
```

### List Models

```bash
GET http://localhost:20128/v1/models
Authorization: Bearer your-api-key

→ Returns all models + combos in OpenAI format
```

## 📧 Support

- **Docs**: [rqzbeh.github.io/KhatamRouter](https://rqzbeh.github.io/KhatamRouter/)
- **GitHub**: [github.com/rqzbeh/KhatamRouter](https://github.com/rqzbeh/KhatamRouter)
- **Issues**: [github.com/rqzbeh/KhatamRouter/issues](https://github.com/rqzbeh/KhatamRouter/issues)

---

## 👥 Contributors

Thanks to all contributors who helped make KhatamRouter better — and to everyone upstream who built the foundation.

[![Contributors](https://contrib.rocks/image?repo=rqzbeh/KhatamRouter&max=150&columns=15&anon=1)](https://github.com/rqzbeh/KhatamRouter/graphs/contributors)

---

## 📊 Star Chart

[![Star History Chart](https://api.star-history.com/svg?repos=rqzbeh/KhatamRouter&type=Date)](https://star-history.com/#rqzbeh/KhatamRouter&Date)

## 🔀 Forks

**[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** — A companion TypeScript fork in the ecosystem. Adds 36+ providers, 4-tier auto-fallback, multi-modal APIs (images, embeddings, audio, TTS), circuit breaker, semantic cache, LLM evaluations, and a polished dashboard. 368+ unit tests. Available via npm and Docker.

---

## 🌱 Built on 9Router by decolua

KhatamRouter is a fork of **[decolua/9router](https://github.com/decolua/9router)** (initialized from `v0.5.104`, commit `87a74e1b`). Everything that made 9Router great — the provider registry, format translators, OAuth token refresh, combo fallback and token savers — is still here, and it is where the credit belongs.

- **Upstream project**: [github.com/decolua/9router](https://github.com/decolua/9router)
- **License**: MIT. KhatamRouter keeps the upstream [`LICENSE`](./LICENSE) and remains MIT-licensed.
- **Staying current**: an automated [upstream sync workflow](./.github/workflows/upstream-sync.yml) runs daily, merges new upstream commits into a review branch, and opens a Pull Request so upstream providers and translator fixes land here quickly. See [`UPSTREAM_SYNC.md`](./.github/UPSTREAM_SYNC.md) for the exact conflict-resolution rules.
- **Upstream audit & ports**: Full audit ledger of 44 candidates ported across VansRouter (`v0.91.61`→`v0.91.81`) and 9router (`v0.5.104`→`v0.5.109`), plus 5 `decolua/9router` PRs (#4988, #5222, #5150, #5179, #5193 via PR #67), along with security hardening and skipped commits, is documented in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md). GitHub repository identity migration is out of scope and has not occurred.

If KhatamRouter is useful to you, please ⭐ the upstream repository too — they did the hard part first.

---

## 🙏 Acknowledgments

Built on the shoulders of giants:

- **[decolua/9router](https://github.com/decolua/9router)** — the upstream project KhatamRouter is forked from and syncs with.
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — original Go implementation that inspired this JavaScript port.
- **[RTK](https://github.com/rtk-ai/rtk)** ![Stars](https://img.shields.io/github/stars/rtk-ai/rtk?style=flat&color=yellow) — Rust token-saver. KhatamRouter ports its compression pipeline to JS → **−20-40% input tokens** on every request.
- **[Caveman](https://github.com/JuliusBrussee/caveman)** ![Stars](https://img.shields.io/github/stars/JuliusBrussee/caveman?style=flat&color=yellow) by **[@JuliusBrussee](https://github.com/JuliusBrussee)** — viral _"why use many token when few token do trick"_. KhatamRouter adapts its prompt → **−65% output tokens**.
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** ![Stars](https://img.shields.io/github/stars/DietrichGebert/ponytail?style=flat&color=yellow) by **[@DietrichGebert](https://github.com/DietrichGebert)** — _"lazy senior dev"_ skill. KhatamRouter injects its YAGNI-first ladder → **fewer tokens, less code, shorter diffs**.

Huge thanks to these authors — without their work, KhatamRouter's token-saving features wouldn't exist. ⭐ them on GitHub!

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ for developers who code 24/7</sub>
</div>
