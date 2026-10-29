# Specifications Index

This directory contains Spec-Kit specifications, implementation plans, and tasks for KhatamRouter feature waves.

| Spec | Title | Status | Branch |
|---|---|---|---|
| [001-bun-ts-runtime-redis-foundation](001-bun-ts-runtime-redis-foundation/) | Wave 1 — Bun TS Runtime & Redis Foundation | Merged (PR #27) | `001-bun-ts-runtime-redis-foundation` |
| [002-db-migrations-hybrid-quota-store](002-db-migrations-hybrid-quota-store/) | Wave 2 — Database Migrations & Hybrid Quota Store | Merged (PR #28) | `002-db-migrations-hybrid-quota-store` |
| [003-acl-granular-limits](003-acl-granular-limits/) | Wave 3 — Unified ACL and Granular Limits | Merged (PR #29, PR #41) | `003-acl-granular-limits` |
| [004-resilience-circuit-breaker](004-resilience-circuit-breaker/) | Wave 4 — 4-State Circuit Breaker, 429 Classification, Cooldowns | Merged (PR #30) | `004-resilience-circuit-breaker` |
| [005-stealth-antiban](005-stealth-antiban/) | Wave 5 — Stealth and Anti-Ban Suite | Merged (PR #31) | `005-stealth-antiban` |
| [006-model-discovery-capabilities](006-model-discovery-capabilities/) | Wave 6 — Live Model Discovery and Capability Resolution | Merged (PR #32) | `feat/wave6-model-discovery` |
| [007-vansrouter-parity](007-vansrouter-parity/) | Wave 7 — VansRouter Provider Parity | Merged (PR #61) | `wave7-vansrouter-parity` |
| [0075-bun-only-redis-default](0075-bun-only-redis-default/) | Wave 7.5 — Bun-Only Runtime and Redis by Default | Merged (PR #63) | `spec/0075-bun-only-redis-default` |
| [008-bun-perf-scale](008-bun-perf-scale/) | Wave 8 — Bun Hot-Path Slim and Vertical Scale (multi-core / multi-process on one host via `node:cluster`; re-lands hot-path perf from reverted 6768fb82; horizontal replicas/nginx/TRUSTED_PROXY_CIDRS explicitly out of scope) | Planned (re-specified for vertical scaling) | `spec/008-vertical-scale` |
| [009-upstream-port](009-upstream-port/) | Wave 9 — Upstream Port (VansRouter 0.91.61→0.91.81, 9router 0.5.104→0.5.109) | Merged (PR #65) | `spec/009-upstream-port` |
| [010-dashboard-tooling](010-dashboard-tooling/) | Wave 8 Dashboard Tooling & Key Quota Management | Merged (PR #72) | `master` |
| [011-branding-update-source](011-branding-update-source/) | KhatamRouter Branding & Release Isolation | In progress | `spec/011-branding-update-source` |
| [012-opencode-wreq-bun](012-opencode-wreq-bun/) | OpenCode Free TLS Client (wreq-js) under Bun | Merged (PR #78) | `port/opencode-bun-native` |
| [013-upstream-0-5-112](013-upstream-0-5-112/) | Wave 13 — Upstream v0.5.112 Port (14 Commits, Core Routing, MiniMax Named-Pipe Lease Broker, DeepSeek PoW Boundary) | Planned | `spec/013-upstream-0-5-112` |
