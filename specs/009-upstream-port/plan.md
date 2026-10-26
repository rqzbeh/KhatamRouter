# Plan: 009 Upstream Port

Scope: 009-upstream-port
Depth: tree 2
Mode: orchestrated

## Contract

- **Branch**: `spec/009-upstream-port` (already checked out). All waves commit here with Conventional Commits + `Co-Authored-By: Claude Code`.
- **Interfaces**: 44 candidates in `.claude/.../workflows/upstream-candidates.json`. Execution rules in `specs/009-upstream-port/spec.md`.
- **Ownership**: exactly one cluster per leaf (union-find over shared files). No two IN-FLIGHT leaves share a file. Singleton clusters run in parallel; multi-candidate clusters run sequentially *inside* one leaf.
- **Dependencies**: land US1 (cluster S security/crash) first, then US2 (C correctness/resilience) + US3 (E enhancements) in later waves. Within a wave all leaves are disjoint.
- **Host launch mode**: Claude Dynamic Workflow, sonnet leaves. Main agent orchestrates/reviews/plans, applies nothing directly.
- **Toolchain**: Bun-only. Graph-first (`search_graph` → `trace_path` → `get_code_snippet`, `check_index_coverage` on every file). Read `open-sse/AGENTS.md` before touching `open-sse/`. `bun x vitest run` from `tests/`, `verify-*.mjs` baselines, goldens for translator changes.
- **Conventions**: security-first review on every leaf (auth, token storage, header handling, SSRF on any new fetch/URL). Fail-open quota / fail-closed auth. Loopback-only XFF trust (008's TRUSTED_PROXY_CIDRS is a *different* branch — do not touch it here).
- **Docker**: container smoke via dedicated subagent only; never `prune`.

## Wave policy

| Wave | Leaves | Why |
|---|---|---|
| 1 | S: security/crash cluster (sequential lane: `a06ec5d8 13441197 1ea22bfa` + `08ef047f 5883110b`) | US1 first, highest value. Two leaves: gemini-translator lane and dep-bump lane (disjoint files). |
| 2 | C1–C4: correctness clusters (`e76a32a0`; combo-credit/backoff pair; combo-4xx/empty/search/smart lane; pi/regex/maxtokens/stream-harness/kiro/argu-tier lane) | US2 correctness, parallel leaves, sequential inside lanes. |
| 3 | C5–C8 + E1: provider/model-capability lanes + codex-image/copilot/gemini-image/ollama-systemone/media/dashboard/test-triage lane | US2 remainder. |
| 4 | E2–E4: codebuddy-auth, qoder/ollama-balance/commandcode lane, rtk-prompt/argu-effort lane + sensenova + stt + smartrouter follow-ons | US3 enhancements; Smart Router adapted to Redis. |
| 5 | Docs + full suite + PR | README/ROADMAP/CHANGELOG, full guard, PR. |

Singletons with disjoint files may be folded into the nearest wave; the leaf ledger is the authority.

## Cluster → leaf map (union-find components)

- **S-gemini** (seq lane): VansRouter `a06ec5d8` (adapt: `__proto__` pollution + fetch timeouts) → `13441197` (gemini `items` strip) → `1ea22bfa` (adapt: `Object.create(null)` + OpenCode id-store split). Files: `open-sse/translator/{formats/gemini.js,request/openai-to-gemini.js}`, `open-sse/executors/opencode.js`, `src/app/api/providers/[id]/models/route.js`.
- **S-deps**: `08ef047f` (undici 7.30.1 + headroom loopback) + `5883110b` (Monaco 0.57.0 pin + loader). Files: `package.json`, `bun.lock`, `docker-compose.yml`, `src/app/(dashboard)/dashboard/translator/page.js`, `src/shared/constants/monaco.js`.
- **C-opencode-think** (seq lane): VansRouter `01f1a1fe` (adapt: `ses_/msg_` real timestamps) + `356f3f5c` (adapt: free catalogue/fingerprint/retry) + 9router `32c5f30a`, `b8331283`, `d07e5bc3` (thinking shape/effort). Files: `open-sse/executors/opencode.js`, `open-sse/providers/registry/opencode*.js`, `open-sse/providers/capabilities.js`, `open-sse/handlers/*`, `open-sse/translator/concerns/thinkingUnified.js`.
- **C-antigravity** (seq lane): VansRouter `39730d88` (adapt: discovery endpoint + no model drop) + 9router `f172c3c4` (UA + Argon tiers) + `82aeb907` (tier resolution) + VansRouter `cc0c2311` (adapt: Cline auto-fetch). Take discovery + headers together.
- **C-codebuddy**: VansRouter `2063f090` (JWT exp + 401 refresh) + 9router `3b137aa6` (Intl backoff rules). Files: `open-sse/executors/default.js`, `open-sse/config/errorConfig.js`, `src/app/api/providers/[id]/test/testUtils.js`.
- **C-combo** (seq lane): `b82f5c4a` (credits) → `5cdcddf5` (adapt: 4xx advance) → `ca7b5401` (adapt: empty-SSE fallthrough) → `9b4ea9eb` (combo search UI) → `f3f86fdd` (adapt: Smart Router, Redis stickiness — US3, may split to wave 4).
- **C-misc-correctness** (parallel singletons, disjoint): `34c66988` (nodesRepo purge), `342ecb0d` (pi-settings 500), `5853a88a` (regex lastIndex), `7c42d8f8` (max_completion_tokens), `95c9d03e` (stream tool-call ids), `3ce2b828` (kiro aliases), `a440ef43` (adapt: headroom tool-output compression), `d56f8f18` (handler audit findings).
- **E-providers/features** (parallel singletons, disjoint): `8a842043` (RTK custom prompt), `dbdbb648` (Copilot catalog), `161e3493` (Gemini ref-images + MITM dir), `bc4a3cc7` (Ollama clef models), `351b04cb` (SenseNova provider), `421f2262` (adapt: Codex STT + ffmpeg), `b08f12d5` (codex-image free skip), `00dd3dfc` + `a3ca2f9b` (media card + key-modal copy), `2720cd2a` (qoder queue/capabilities), `31b8439b` (ollama /api/balance), `4a76b8de` (commandcode quota), `b6a9ca43` (test triage).

## Risks

- The 16-candidate hub shares `capabilities.js`/`combo.js`/`chatCore.js` — sequential lane, never parallel.
- Smart Router's upstream in-memory stickiness MUST become Redis-backed (FR-003); split it to wave 4 if it blocks the combo lane.
- Codex STT needs `ffmpeg` in `Dockerfile.bun` builder — verify the build gate passes.
- `b6a9ca43` touches the failing-suite baseline — update `known-fails.txt` only with measured evidence, never silently.
