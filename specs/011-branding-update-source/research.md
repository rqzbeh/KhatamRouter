# Research & Codebase Inventory: Branding & Update Source Isolation

**Branch**: `spec/011-branding-update-source`  
**Date**: 2026-10-26  
**Subject**: Decoupling KhatamRouter from upstream `decolua/9router` update feeds and establishing standalone KhatamRouter identity while preserving backward compatibility.

---

## 1. Executive Summary & Problem Diagnosis

### The Issue
Users reported two tightly coupled problems when deploying and opening KhatamRouter:
1. **Residual Upstream Branding**: The web dashboard, page titles, login panel, sidebar modals, and CLI banners still identified as `9router` / `9Router Proxy`.
2. **Supply-Chain Overwrite via Upstream Update Checks**: Both the Next.js dashboard update endpoint (`/api/version`) and the launcher CLI (`cli/cli.js`) checked for new releases against the public npm registry for the package `9router` (`https://registry.npmjs.org/9router/latest`). When an upstream version was newer than the fork's version, the UI prompted the user to update via `npm i -g 9router@latest`, and the automated updater (`src/lib/appUpdater.js`) directly spawned an npm install command that **replaced the local KhatamRouter build with upstream's unhardened Node package**.

### Risk Classification
- **Supply-Chain Integrity**: CRITICAL. Allowing an automated or guided update process to fetch and execute third-party code from an upstream registry completely breaks the security boundary of the fork.
- **Data Continuity**: HIGH. Blindly renaming filesystem paths (such as `~/.9router/db/data.sqlite`) or config keys (such as `model_providers.9router` in `~/.codex/config.toml`) would orphan user databases and disconnect connected CLI tools.

---

## 2. Inventory Part A: Update-Check & Updater Subsystems

| Component | File Path | Existing Implementation | Risk / Defect | Remediation Strategy |
|---|---|---|---|---|
| Dashboard Version API | `src/app/api/version/route.js` | Queries `https://registry.npmjs.org/9router/latest` via https.get | Checks upstream package; returns `hasUpdate` based on upstream releases | Query GitHub Releases/Tags API of `rqzbeh/KhatamRouter` with pinned host, 4s timeout, 1h cache, fail-open, runtime detection |
| Dashboard Update Execution | `src/app/api/version/update/route.js` | Invokes `spawnUpdaterAndExit()` in production | Would trigger detached npm install of upstream package | Disable in-place package update (fail-closed, returns 403); guide operator to container or git update |
| In-Place App Updater | `src/lib/appUpdater.js` | Executes `npm i -g 9router@latest --prefer-online` and kills matching PIDs | Replaces KhatamRouter binary with upstream 9router package | Neutralize in-place updater; fail-closed by default; broaden PID matching to `9router` AND `khatamrouter` |
| Detached Updater Process | `src/lib/updater/updater.js` | Detached child process running `npm i -g ${packageName}` | Can overwrite files after main process terminates | Hard fail-closed; refuse execution unless verified internal package |
| UI Sidebar Version Badge & Modal | `src/shared/components/Sidebar.js` | Shows "Update 9Router"; displays `UPDATER_CONFIG.installCmdLatest` | Shows `npm i -g 9router@latest` even in Docker or Bun source | Display "Update KhatamRouter"; show context-aware command matching detected runtime (Docker compose vs git/bun) |
| App & Updater Config | `src/shared/constants/config.js` | `APP_CONFIG.name = "9Router Proxy"`, `UPDATER_CONFIG.installCmdLatest = "npm i -g 9router@latest ..."` | Hardcodes upstream branding and npm update command | Update `APP_CONFIG.name = "KhatamRouter"`; replace npm updater config with repo and runtime-aware presets |
| CLI Version Check | `cli/cli.js` | `checkForUpdate()` queries `registry.npmjs.org/${pkg.name}/latest` | Pulls upstream version and prompts user to exit and run `npm i -g 9router@latest` | Switch update check to GitHub Releases API of `rqzbeh/KhatamRouter`; fail-open; support `KHATAM_UPDATE_CHECK=0` |
| CLI Package Manifest | `cli/package.json` | `"name": "9router"`, `"bin": { "9router": "./cli.js" }` | Only exposes `9router` binary; package name reflects upstream | Keep `name: "9router"` (no npm publish pipeline exists for KhatamRouter), but add dual binary alias `"khatamrouter": "./cli.js"` |
| Landing Get Started | `src/app/landing/components/GetStarted.js` | Code snippet displays `npx 9router` | Leads users to download upstream package from npm | Show Docker run or Bun dev command matching KhatamRouter deployment |
| Docker Publishing | `.github/workflows/docker-publish.yml` | Publishes `ghcr.io/${{ github.repository_owner }}/khatamrouter` | Authoritative source of container releases | Use GHCR image name as official Docker update source |
| CI Workflows | `.github/workflows/` | No `npm publish` workflow exists in repo | Proves KhatamRouter does not publish to npm registry | Do NOT invent a non-existent npm package name for update guidance |

---

## 3. Inventory Part B: String Classification (Display vs Functional vs Attribution)

### Category 1: User-Visible Display Strings (Target for Rename to KhatamRouter)
These strings appear in UI text, document titles, modal headers, CLI banners, and tooltips where user expectation is seeing the product identity:
- `src/shared/constants/config.js`: `APP_CONFIG.name = "KhatamRouter"` (formerly `"9Router Proxy"`).
- `src/app/layout.js`: metadata title `"KhatamRouter - AI Infrastructure Management"`.
- `src/app/manifest.js`: application manifest `name: "KhatamRouter - AI Infrastructure Management"`, `short_name: "KhatamRouter"`.
- `src/app/login/page.js`: Header `<h1>KhatamRouter</h1>`.
- `src/shared/components/Header.js`: Tooltip descriptions ("route through KhatamRouter", "to use KhatamRouter").
- `src/shared/components/Sidebar.js`: Modal title "Update KhatamRouter", step descriptions.
- `src/app/landing/`:
  - `components/Navigation.js`: logo text "KhatamRouter", repo link to `rqzbeh/KhatamRouter`.
  - `components/HeroSection.js`: GitHub links pointing to `rqzbeh/KhatamRouter`.
  - `components/HowItWorks.js`: "How KhatamRouter Works", "KhatamRouter Hub".
  - `components/GetStarted.js`: "Install KhatamRouter", terminal display "Starting KhatamRouter...".
  - `components/Footer.js`: "KhatamRouter", copyright notice, GitHub links.
  - `components/FlowAnimation.js`: Center node label "KhatamRouter".
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`: "Expose your local KhatamRouter to the internet...".
- `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`: "the KhatamRouter data directory...".
- `src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`: central hub node labeled "KhatamRouter".
- `src/app/(dashboard)/dashboard/cli-tools/components/`:
  - `AntigravityToolCard.js`: "Maps Antigravity models to any provider via KhatamRouter".
  - `MitmServerCard.js`: "...with ANY provider/model from KhatamRouter", "KhatamRouter Base URL".
  - `MitmToolCard.js`: "redirect {tool.name} traffic through KhatamRouter via MITM".
  - `ToolSummaryCard.js`: status labels.
- `cli/cli.js`: Banner strings ("Starting with Wave 7.5, KhatamRouter runs exclusively on Bun", "🔔 KhatamRouter is running in tray", "🔔 KhatamRouter is now running in background").
- `cli/README.md`: Title `# KhatamRouter - Dual-Runtime AI Gateway`, documentation and quickstart instructions.

### Category 2: Functional Identifiers (MUST PRESERVE / DUAL-READ)
These identifiers are embedded in user files, databases, third-party CLI configurations, or process tables. Altering them would break existing deployments:
1. **Data Directory Path**:
   - `~/.9router` (macOS/Linux) and `%APPDATA%/9router` (Windows).
   - Reason: Standardized in CLAUDE.md ("DB file location resolves via src/lib/db/paths.js (DATA_DIR, else ~/.9router/)"). Moving this path would cause all existing users to lose their SQLite database, usage logs, and credentials.
2. **Third-Party CLI Tool Config Keys**:
   - **Codex** (`~/.codex/config.toml`): `model_providers.9router` and `model_provider = "9router"`. Connect tools and status checkers must recognize both `9router` and `khatamrouter`.
   - **OpenCode** (`~/.config/opencode/opencode.json`): `provider["9router"]` and `model = "9router/${model}"`. Must recognize both.
   - **Droid / Factory** (`~/.factory/settings.json`): `custom:9Router-${i}` and `custom:9Router-0`. Must recognize both `custom:9Router` and `custom:KhatamRouter`.
   - **Crush** (`~/.config/crush/crush.json`): `providers["9router"]`. Must recognize both.
   - **Pi** (`~/.pi/agent/config.json`): `providers["9router"]`. Must recognize both.
   - **OMP (Oh My Pi)** (`~/.config/omp/config.yaml`): `providers["9router"]`. Must recognize both.
   - **VS Code Copilot extension**: Provider configuration entry name `"9Router"`.
3. **Backup File Naming & Backup Restore**:
   - `*.bak-9router`: Created when configuring CLI tools. Restore operations look for this specific backup suffix.
   - Profile export/import: Supports both `9router-backup-*.json` and `khatamrouter-backup-*.json`.
4. **API Contract Compatibility**:
   - `status.has9Router`: Returned by all `/api/cli-tools/*-settings` endpoints. All frontend cards check `status.has9Router`. Adding `hasKhatamRouter = has9Router` while keeping `has9Router` ensures zero breakage.
5. **Process Table Matching**:
   - `killAppProcesses` / `collectAppPids`: Must search for command lines containing `9router` OR `khatamrouter` to ensure graceful cleanup of both legacy and new process instances.
6. **SAML Entity ID**:
   - Default SP entity ID: `"urn:9router:sp"`. Changing this would invalidate configured enterprise SAML assertions. Both `urn:9router:sp` and `urn:khatamrouter:sp` must be accepted.
7. **CLI Executable Names**:
   - Both `9router` and `khatamrouter` bin aliases must be mapped in `cli/package.json`.

### Category 3: Attribution, Licensing & Historical Lineage (MUST KEEP)
- `cli/LICENSE`: Copyright notice acknowledging upstream contributors (`Copyright (c) 2026 9Router Contributors`).
- Root `CHANGELOG.md` & `cli/README.md`: Acknowledgments to upstream lineage (`decolua/9router`, `Vanszs/VansRouter`, `CLIProxyAPI`).

---

## 4. Recorded Architectural Decisions

### Decision 1: Releases API as Update Source of Truth
- **Source**: `https://api.github.com/repos/rqzbeh/KhatamRouter/releases/latest` (fallback to `tags` if no formal releases yet).
- **Security Constraints**:
  - Pinned host: strictly `api.github.com`.
  - Request timeout: 4,000 ms.
  - In-memory cache TTL: 3,600,000 ms (1 hour).
  - Semver comparison: Strict semver stripping optional leading `v`.
  - Redirect handling: Reject off-host redirects.
  - Authentication: Zero auth tokens sent (purely unauthenticated public GET).
  - Fail-Open: On any network failure, timeout, non-200 status, or parse error, resolve `latestVersion: null` and `hasUpdate: false`.
- **Environment Overrides**:
  - `KHATAM_UPDATE_REPO`: overrides repo slug (default: `"rqzbeh/KhatamRouter"`).
  - `KHATAM_UPDATE_CHECK=0`: completely disables remote update checks.

### Decision 2: Context-Aware Install & Update Guidance
- The system inspects its execution environment:
  - **Docker Container**: Detected via `fs.existsSync("/.dockerenv") || process.env.KHATAM_DOCKER === "1" || process.env.DATA_DIR === "/app/data"`.
    - Install Command: `docker compose pull && docker compose up -d`
    - Instructions: Container image will be updated from `ghcr.io/rqzbeh/khatamrouter:latest`.
  - **Bun Git Checkout**: Detected via `fs.existsSync(path.join(process.cwd(), ".git"))`.
    - Install Command: `git pull && bun install && bun run build:bun && bun run start:bun`
  - **Standalone / Other**:
    - Guidance directs user to GitHub release page `https://github.com/rqzbeh/KhatamRouter/releases/latest`.
- **Zero Hallucinated NPM Guidance**: Because no npm publishing pipeline exists in `.github/workflows/`, the dashboard and CLI will NEVER instruct users to run `npm install -g khatamrouter` or `npm install -g 9router`.

### Decision 3: Fail-Closed Neutralization of In-Place Auto-Updater
- `POST /api/version/update` responds with HTTP 403:
  `{ success: false, message: "In-place package update is disabled in KhatamRouter. Please update via container or git pull." }`
- `src/lib/appUpdater.js` and `src/lib/updater/updater.js` are neutralized so no code path can ever execute `npm i -g 9router` or execute upstream scripts.

### Decision 4: CLI Package & Binary Preservation
- In `cli/package.json`:
  - Retain `"name": "9router"` to avoid breaking local CLI tooling scripts that inspect `package.json`.
  - Add `"khatamrouter": "./cli.js"` to `"bin"`, alongside `"9router": "./cli.js"`.
  - Update `"description"` to `"KhatamRouter CLI - Start and manage KhatamRouter server (requires Bun runtime)"`.
- In `cli/cli.js`:
  - Update `checkForUpdate()` to query `api.github.com/repos/rqzbeh/KhatamRouter/releases/latest`.
  - Replace `INSTALL_CMD_LATEST` with context-appropriate guidance.
  - Update process kill patterns to match both `9router` and `khatamrouter`.
