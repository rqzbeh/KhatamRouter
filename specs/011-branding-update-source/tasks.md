# Tasks: KhatamRouter Branding & Release Isolation

**Feature Branch**: `spec/011-branding-update-source`  
**Status**: Ready for Implementation  
**Specification**: `specs/011-branding-update-source/spec.md`  
**Plan**: `specs/011-branding-update-source/plan.md`

---

## Task Overview & Ownership Map

| Task ID | Summary | Owns | Oracle |
|---|---|---|---|
| **T1** | Update-Check API, Runtime Guidance & In-Place Updater Neutralization | `src/app/api/version/route.js`, `src/app/api/version/update/route.js`, `src/lib/appUpdater.js`, `src/lib/updater/updater.js`, `src/shared/components/Sidebar.js`, `src/shared/constants/config.js`, `tests/unit/update-check-and-updater.test.js` | `bun x vitest run unit/update-check-and-updater.test.js` |
| **T2** | CLI Branding, Dual Binary Alias & CLI Update Source | `cli/package.json`, `cli/cli.js`, `cli/README.md`, `tests/unit/cli-branding.test.js` | `bun x vitest run unit/cli-branding.test.js` |
| **T3** | Dashboard & Landing User-Facing Display Rebranding | `src/app/layout.js`, `src/app/manifest.js`, `src/app/login/page.js`, `src/app/landing/components/Navigation.js`, `src/app/landing/components/HeroSection.js`, `src/app/landing/components/HowItWorks.js`, `src/app/landing/components/GetStarted.js`, `src/app/landing/components/Footer.js`, `src/app/landing/components/FlowAnimation.js`, `src/app/landing/page.js`, `src/shared/components/Header.js`, `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`, `src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js`, `src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js`, `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`, `src/shared/constants/cliTools.js`, `tests/unit/dashboard-display-branding.test.js` | `bun x vitest run unit/dashboard-display-branding.test.js` |
| **T4** | Documentation, Specs, Gates & Acceptance Audit | `specs/011-branding-update-source/**`, `.unlazy/011-branding-update-source/**`, `tests/unit/spec-docs-audit.test.js` | `node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/011-branding-update-source/GATES.md` |

---

## Detailed Task Breakdown

### Task 1: Update-Check API, Runtime Guidance & In-Place Updater Neutralization (T1)
- [ ] Refactor `src/app/api/version/route.js`:
  - Query GitHub Releases/Tags API of `rqzbeh/KhatamRouter` via pinned host `api.github.com`.
  - Add 4s timeout, 1h in-memory cache, fail-open error handling.
  - Implement strict semver comparison.
  - Implement runtime detection (Docker container vs Bun Git checkout vs standalone).
  - Return `{ currentVersion, latestVersion, hasUpdate, runtime, installCmd, releaseUrl }`.
  - Support `KHATAM_UPDATE_CHECK=0` and `KHATAM_UPDATE_REPO` environment overrides.
- [ ] Neutralize `src/app/api/version/update/route.js`:
  - Return HTTP 403 Forbidden with fail-closed response.
- [ ] Neutralize `src/lib/appUpdater.js` and `src/lib/updater/updater.js`:
  - Fail-closed `spawnUpdaterAndExit` to prevent any execution of `npm i -g 9router`.
  - Broaden PID discovery in `collectAppPids` to match both `9router` and `khatamrouter`.
- [ ] Update `src/shared/components/Sidebar.js` & `src/shared/constants/config.js`:
  - Consume dynamic `installCmd` from `/api/version`.
  - Update update modal title to `"Update KhatamRouter"`.
  - Update `UPDATER_CONFIG` in `src/shared/constants/config.js` to reference KhatamRouter repository and remove `npmPackageName: "9router"`.
- [ ] Create `tests/unit/update-check-and-updater.test.js`.

### Task 2: CLI Branding, Dual Binary Alias & CLI Update Source (T2)
- [ ] Update `cli/package.json`:
  - Retain package name `"name": "9router"`.
  - Add dual binary alias in `"bin"`: `"9router": "./cli.js"`, `"khatamrouter": "./cli.js"`.
  - Update `"description"` to `"KhatamRouter CLI - Start and manage KhatamRouter server (requires Bun runtime)"`.
- [ ] Update `cli/cli.js`:
  - Update `checkForUpdate()` to query `api.github.com/repos/rqzbeh/KhatamRouter/releases/latest`.
  - Add support for `KHATAM_UPDATE_CHECK=0`.
  - Replace `INSTALL_CMD_LATEST` with context-appropriate guidance.
  - Update startup and tray banners to display `"KhatamRouter"`.
  - Broaden process kill whitelist in `killAllAppProcesses` to match both `9router` and `khatamrouter`.
- [ ] Update `cli/README.md`:
  - Update title to `# KhatamRouter - Dual-Runtime AI Gateway & Proxy`.
  - Emphasize Docker (`ghcr.io/rqzbeh/khatamrouter:latest`) and local Bun runtime.
- [ ] Create `tests/unit/cli-branding.test.js`.

### Task 3: Dashboard & Landing User-Facing Display Rebranding (T3)
- [ ] Update `src/shared/constants/config.js`:
  - `APP_CONFIG.name = "KhatamRouter"`.
- [ ] Update document metadata:
  - `src/app/layout.js`: Title `"KhatamRouter - AI Infrastructure Management"`.
  - `src/app/manifest.js`: Name and short name `"KhatamRouter"`.
- [ ] Update `src/app/login/page.js`:
  - Header text `<h1>KhatamRouter</h1>`.
- [ ] Update `src/shared/components/Header.js`:
  - Descriptions to `"route through KhatamRouter"`, `"to use KhatamRouter"`.
- [ ] Update landing page components in `src/app/landing/`:
  - Navigation, HeroSection, HowItWorks, GetStarted, Footer, FlowAnimation, page.
  - Links to `https://github.com/rqzbeh/KhatamRouter`.
- [ ] Update dashboard tool cards & views:
  - `AntigravityToolCard.js`, `MitmServerCard.js`, `MitmToolCard.js`, `CopilotToolCard.js`, `EndpointPageClient.js`, `TokenSaverClient.js`, `ProviderTopology.js`, `src/shared/constants/cliTools.js`.
- [ ] Verify functional identifiers remain untouched:
  - Data directory `~/.9router/` / `%APPDATA%/9router`.
  - Tool keys (`model_providers.9router`, `provider["9router"]`, `custom:9Router-*`, etc.).
  - Backup suffix `*.bak-9router`.
  - API response field `status.has9Router`.
- [ ] Create `tests/unit/dashboard-display-branding.test.js`.

### Task 4: Documentation, Specs, Gates & Acceptance Audit (T4)
- [ ] Create Spec-Kit package under `specs/011-branding-update-source/`:
  - `spec.md`, `plan.md`, `tasks.md`, `research.md`.
- [ ] Create Unlazy package under `.unlazy/011-branding-update-source/`:
  - `PLAN.md`, `GATES.md`.
- [ ] Verify gate linting:
  - `node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/011-branding-update-source/GATES.md` exits 0.
- [ ] Run regression suite:
  - `bun x vitest run unit/capabilities.test.js`.
- [ ] Create `tests/unit/spec-docs-audit.test.js`.
