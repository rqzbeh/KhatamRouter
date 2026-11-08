# Spec 017 Provider Discovery & Listing Completeness Ledger

**Feature**: `017-model-import-testing`  
**Slice**: Provider Discovery & Listing Completeness Backend Slice  
**Date**: 2026-11-08  
**Status**: Frozen for Parent Review & Verification  

---

## 1. Strict Ownership & Boundary Contract

This slice strictly owns and modifies only the designated discovery completeness files:
- `src/lib/models/listingCompleteness.js` (NEW: pure shared shape evaluation & pagination detection)
- `src/app/api/providers/[id]/models/route.js` (EDIT: provider discovery dispatch, pagination runners, static fallback)
- `tests/unit/provider-listing-completeness.test.js` (NEW: comprehensive unit test suite)
- `specs/017-model-import-testing/provider-discovery-ledger.md` (this audit & matrix ledger)

**Exclusions**:
- Importer (`src/lib/models/importOrchestrator.js`): untouched (other writers)
- Catalog reconciliation (`src/lib/models/catalogReconcile.js`): untouched (other writers)
- Database repositories (`src/lib/db/repos/*`): untouched (other writers)
- Provider UI components (`src/shared/components/*`): untouched (other writers)
- Model cache & proxies (`src/lib/network/*`, `open-sse/services/*`): untouched (other writers)

---

## 2. Core Problem Statement & Completeness Invariant

In merged PR #140, KhatamRouter introduced snapshot pruning protection:
- `importProviderModels` prunes obsolete models **only when** `discovery.complete === true` and no warning/error/fallback is flagged.
- Any raw invalid record in the returned model listing suppresses catalog pruning (`skipped: { prune: "invalid_records" }`).
- However, prior to this slice, `src/app/api/providers/[id]/models/route.js` only set `complete: true/false` on custom gateway nodes (`isOpenAICompatibleProvider` and `isAnthropicCompatibleProvider`). All built-in providers (OpenAI, NVIDIA, Gemini, Anthropic, DeepSeek, etc.) returned no `complete` field, rendering all built-in imports non-authoritative and unable to prune obsolete models.
- Furthermore, providers lacked pagination handling for official Gemini (`nextPageToken`), native Anthropic (`has_more`/`last_id`), and Cloudflare Workers AI (`page`/`per_page`/`total_pages`).
- Finally, providers without listing endpoints emitted a generic 400 error rather than falling back safely to static models with `complete: false`.

### The Invariant
Every provider listing response now guarantees an unambiguous completeness status:
1. `complete: true` **only** when an adapter provides proven, exhaustive listing evidence:
   - Valid unpaginated array with verified absence of pagination markers (`unpaginated_authoritative`).
   - Fully consumed Anthropic cursor chain with terminating `has_more: false` (`exhausted_cursor_chain`).
   - Fully consumed Gemini page chain with terminating absent `nextPageToken` (`exhausted_token_pages`).
   - Fully consumed Cloudflare numeric page chain (`exhausted_numeric_pages`).
   - Validated unpaginated dictionary shape proved by a custom resolver (`proven_custom_resolver`).
2. `complete: false` on any pagination signal, cycle, page cap, deadline cutoff, intermediate error, unrecognized shape, OAuth custom resolver without completeness proof, or static catalog fallback.
3. Raw invalid items are **never dropped** by the route handler; they pass through to `importOrchestrator` so `inspectRawListing` can count them and refuse destructive pruning safely.
4. An explicit `completenessProvenance` field is added to all response envelopes for observability and debugging.

---

## 3. Provider Discovery & Completeness Classification Matrix

| Provider Category | Example Provider IDs | Discovery Mechanism | Pagination Handling | Completeness Verdict & Provenance |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI-Compatible Custom Gateway** | `openai-compatible-chat-*` | `/models` on custom baseUrl (SSRF/TLS guarded) | Checks `hasOpenAIPaginationSignal` | `complete: !hasPagination`<br>`unpaginated_authoritative` or `partial_pagination_signal` |
| **Anthropic-Compatible Custom Gateway** | `anthropic-compatible-chat-*` | `/models` on custom baseUrl (SSRF/TLS guarded) | Cursor chain (`after_id`, max 20, cycle check) | `complete: true` on clean finish (`exhausted_cursor_chain`); `false` on cap/cycle/error |
| **Built-in OpenAI-Style Fixed URLs** | `openai`, `nvidia`, `deepseek`, `groq`, `xai`, `mistral`, `perplexity`, `together`, `fireworks`, `cerebras`, `cohere`, `nebius`, `siliconflow`, `hyperbolic`, `ollama`, `nanobanana`, `chutes`, `assemblyai`, `vercel-ai-gateway`, `tokenharbor`, `dahl`, `atria`, `agnes`, `bai`, `alicode`, `alicode-intl`, `alims-intl`, `volcengine-ark`, `byteplus`, `muse`, `nous` | Fixed URL defined via `createOpenAIModelsConfig` with `listingShape: "openai"` | Validates `data/models/results/directarray`; inspects pagination signals | `complete: true` on unpaginated clean array (`unpaginated_authoritative`); `complete: false` on markers or unrecognized shape |
| **Official Gemini** | `gemini` | `https://generativelanguage.googleapis.com/v1beta/models` via `listingShape: "gemini"` | `nextPageToken` loop via `URLSearchParams` (max 20 pages, 160k records, 30s deadline, cycle detection, sanitized error logging) | `complete: true` on exhausted pages (`exhausted_token_pages`); `complete: false` on cycle/error/cap |
| **Native Anthropic / Claude** | `anthropic`, `claude` | Fixed URL `https://api.anthropic.com/v1/models` via `listingShape: "anthropic"` | `has_more` + `after_id` chain (fixed URL, max 20 pages, cycle detection, strict boolean check) | `complete: true` on clean finish (`exhausted_cursor_chain`); `complete: false` on cycle/error/cap |
| **Cloudflare Workers AI** | `cloudflare`, `cloudflare-ai` | Fixed URL `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search` | Strict accountId validation (`^[A-Za-z0-9_-]{1,128}$`), numeric `page` pagination against `result_info.total_pages`, proxy fail-closed 503 | `complete: true` on clean finish (`exhausted_numeric_pages`); `complete: false` on cycle/error/cap |
| **Validated OAuth Resolver** | `antigravity` | Google Cloud Code Internal API (`v1internal:fetchAvailableModels`) | Validates complete models object dictionary without pagination signals | `complete: true` when proven (`proven_custom_resolver`) |
| **Unproven OAuth / Custom Resolvers** | `codex`, `kimchi`, `cursor`, `zed`, `cline`, `clinepass`, `kiro`, `qoder`, `qoder-cn`, `gemini-cli`, `grok-cli`, `ollama-local`, `github` | Custom resolvers & token refresh pipelines | Filtered models or partial catalogs | `complete: false`<br>`unverified_custom_resolver` |
| **Static Catalog Fallback** | Unconfigured providers with static models (`blackbox`, `deepinfra`, `fal-ai`, `baseten`, `comfyui`, `databricks`, `featherless`, `friendli`, `galadriel`, `gigachat`, `glm`, `hive`, `huggingface`, `kimi`, `meta`, `minimax`, `novita`, `octoai`, `replicate`, `together-ai`, etc.) | Static lookup via `getStaticProviderModels(providerId)` | N/A | `complete: false`<br>`static_catalog_fallback`<br>with explicit warning |
| **Truly Unsupported Providers** | Providers with neither dynamic endpoint nor static models | Returns HTTP 400 | N/A | N/A (HTTP 400 error) |

---

## 4. Security & Transport Findings

### 4.1 Proxy-Aware Discovery & Fail-Closed Guard
- **The Problem**: Built-in providers previously executed direct host `timedFetch`. If a user routed providers through a proxy (standard on restricted VPS setups), a crude universal block turned all proxied discovery into 503, breaking Import and sync entirely. Conversely, bypassing the proxy would leak the host IP and violate strict routing guarantees.
- **The Proxy-Aware Solution**:
  - For built-in fixed-URL configs and native runners (Gemini, Anthropic, Cloudflare), `timedFetch` now wraps `proxyAwareFetch(url, { ...opts, signal }, proxyOptions)` using the resolved config shape from `resolveConnectionProxyConfig(connection.providerSpecificData)`.
  - `validateProxySupport` checks proxy validity:
    - Supported proxy types (`http`, `vercel`, `cloudflare`, `deno`, `netlify`, `psiphon`) with a valid proxy target (`connectionProxyUrl`, `vercelRelayUrl`, or `psiphonPoolId`) are executed via `proxyAwareFetch` with `strictProxy: true`, ensuring requests route through the proxy and never fall back to direct host egress on failure.
    - If proxy resolution fails (`source: "error"` or `error`), an unsupported proxy pool type is specified, or strict mode has no resolved proxy target, the handler fails closed with HTTP 503 (`fail-closed`).
    - Custom OpenAI and Anthropic compatible gateways maintain their dedicated PR133 fail-closed behavior (separate trust path).
- **Psiphon Preserved**: Psiphon pool selection and tunnel establishment are consumed strictly through `resolveConnectionProxyConfig` and `proxyAwareFetch` without touching tunnel rotation or pool allocation logic.

### 4.2 Caller Signal Abort & Active Stream Cancellation
- `resolveProviderModels(request, id, { signal } = {})` accepts an optional caller cancellation signal (e.g. from `request?.signal` or background auto-sync controllers).
- In Gemini, Cloudflare, and Anthropic pagination loops, `AbortSignal.any` combines the caller signal, an active 30s deadline signal (`AbortSignal.timeout(30000)`), and per-page timeout (8s).
- On any non-ok response, JSON parse failure, or pagination abort, `response.body?.cancel?.()` is invoked immediately to release underlying socket and stream resources.

### 4.3 Task Mapping & Malformed Record Contract
- **Cloudflare Task Normalization**: `CLOUDFLARE_TASK_MAP` maps exact Cloudflare Workers AI task categories:
  - `Image-to-Text` is mapped to `{ type: "llm", kind: "llm", supportsVision: true }` (vision LLM, not image generation).
  - `Text-to-Image` is mapped to `{ type: "image", kind: "image" }`.
  - `Image-to-Image` and `Inpainting` map to image editing tasks with capability tags.
  - Speech tasks are classified explicitly (`stt` for recognition, `tts` for speech synthesis).
  - Unknown task categories are preserved as unknown (`type` and `kind` undefined) without falsely inferring `llm` or `chat`.
- **Malformed Record Safety**: Records lacking a non-empty string `id` or `name` are never given fallback strings that turn invalid records into valid records. They pass through with empty identifiers so `importOrchestrator` flags `invalid_records` and refuses destructive catalog pruning.
- **Credential Scrubbing**: `sanitizeNoKeys` scrubs `key=...` query parameters and raw tokens (`accessToken`, `refreshToken`, `apiKey`) from all logged messages and error strings. Raw HTTP error bodies are never logged.

---

## 5. Verification & Test Evidence

Test execution verified using Bun v1.4.4:
- `tests/unit/provider-listing-completeness.test.js`: **29 passing**
- `tests/unit/import-route-completeness.test.js`: **8 passing**
- Full gateway & model suite: **123 passing** across 20 test files
- Linting: `bun x eslint` completely clean (0 errors, 0 warnings).
