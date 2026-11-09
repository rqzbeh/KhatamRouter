# Tasks: 018 OpenCode Unlimited Sidecar + Proxy Rotation

Ownership is disjoint per leaf; no two leaves touch the same file.

- [ ] T1 (leaf-1) Sidecar core: release pin, config, supervisor, public index. Owns `src/lib/network/opencode2api/**`, `tests/unit/opencode2api-release-pin.test.js`, `tests/unit/opencode2api-config.test.js`, `tests/unit/opencode2api-supervisor.test.js`, `tests/fixtures/fake-opencode2api.mjs`.
- [ ] T2 (leaf-2) Psiphon warm ring. Owns `src/lib/network/psiphon/psiphonManager.js`, `tests/unit/psiphon-warm-ring.test.js`.
- [ ] T3 (leaf-3) Egress wiring: resolver, proxyFetch rewrite, proxyOptions/providerSpecificData forwarding, chat retry budgets. Owns `src/lib/network/connectionProxy.js`, `open-sse/utils/proxyFetch.js`, `open-sse/handlers/chatCore.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js`, `tests/unit/opencode2api-egress.test.js`.
- [ ] T4 (leaf-4) Pool API + type registry + listing completeness. Owns `src/app/api/proxy-pools/**`, `src/lib/models/listingCompleteness.js`, `tests/unit/opencode2api-pool-api.test.js`.
- [ ] T5 (leaf-5) Dashboard: selector, config inputs, status badge, free-proxy card mount. Owns `src/app/(dashboard)/dashboard/proxy-pools/page.js`.
- [ ] T6 (leaf-6) Packaging: both Dockerfiles, release pin test parse, docs, changelog, roadmap, specs index.
- [ ] T7 (branch) Integration gates: full targeted suite, lint, syntax check, VPS smoke.

Dependencies: T3 needs T1 exports and T2's rotate contract; T4/T5 need T1 config exports; T6 needs T1 manifest. T2 and T1 are parallel. T3 after both. T4/T5 after T1. T6 after T1.