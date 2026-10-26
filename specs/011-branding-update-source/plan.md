# Implementation Plan: KhatamRouter Branding & Release Isolation

**Feature Branch**: `spec/011-branding-update-source`  
**Status**: Ready for Tasks  
**Classification**: Implementation Architecture

---

## 1. Architecture & Component Interaction

```
┌──────────────────────────────────────────────────────────┐
│              Update Feed Architecture                    │
│                                                          │
│  GET /api/version   ───►  Check KHATAM_UPDATE_CHECK=0    │
│  cli/cli.js               │ (if 0: return hasUpdate:false│
│                           ▼                              │
│                      In-Memory Cache (TTL: 1h)           │
│                           │                              │
│                           ▼ (on cache miss)              │
│                      https://api.github.com/             │
│                      repos/rqzbeh/KhatamRouter/          │
│                      releases/latest (4s timeout)        │
│                           │                              │
│                           ▼                              │
│                      Strict Semver Comparison            │
│                           │                              │
│                           ▼                              │
│                      Runtime Detection                   │
│                      • Docker: /.dockerenv               │
│                      • Bun Git: .git/                    │
│                      • Standalone                        │
│                           │                              │
│                           ▼                              │
│  Response: { currentVersion, latestVersion, hasUpdate,   │
│              runtime, installCmd, releaseUrl }           │
└──────────────────────────────────────────────────────────┘
```

---

## 2. File Modification & Disjoint Ownership Boundaries

| Task ID | Task Name | Owned File Paths |
|---|---|---|
| **T1** | Update-Check API & Updater Neutralization | `src/app/api/version/route.js`<br>`src/app/api/version/update/route.js`<br>`src/lib/appUpdater.js`<br>`src/lib/updater/updater.js`<br>`src/shared/components/Sidebar.js`<br>`src/shared/constants/config.js`<br>`tests/unit/update-check-and-updater.test.js` |
| **T2** | CLI Branding & Dual Binary Alias | `cli/package.json`<br>`cli/cli.js`<br>`cli/README.md`<br>`tests/unit/cli-branding.test.js` |
| **T3** | Dashboard & Landing Display Branding | `src/app/layout.js`<br>`src/app/manifest.js`<br>`src/app/login/page.js`<br>`src/app/landing/components/Navigation.js`<br>`src/app/landing/components/HeroSection.js`<br>`src/app/landing/components/HowItWorks.js`<br>`src/app/landing/components/GetStarted.js`<br>`src/app/landing/components/Footer.js`<br>`src/app/landing/components/FlowAnimation.js`<br>`src/app/landing/page.js`<br>`src/shared/components/Header.js`<br>`src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`<br>`src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`<br>`src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`<br>`src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js`<br>`src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js`<br>`src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`<br>`src/shared/constants/cliTools.js`<br>`tests/unit/dashboard-display-branding.test.js` |
| **T4** | Documentation, Specs & Gates Audit | `specs/011-branding-update-source/**`<br>`.unlazy/011-branding-update-source/**`<br>`tests/unit/spec-docs-audit.test.js` |

*Invariant*: All 4 tasks have strictly disjoint file ownership sets. No two tasks write to the same file.

---

## 3. Detailed Component Designs

### 3.1 Task T1: Update-Check API & Updater Neutralization

#### `src/app/api/version/route.js`
- **Configuration & Caching**:
  - `DEFAULT_REPO = "rqzbeh/KhatamRouter"`
  - `REPO = process.env.KHATAM_UPDATE_REPO || DEFAULT_REPO`
  - Validates `REPO` pattern `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`
  - `global.__khatamVersionCache = { value: null, fetchedAt: 0 }`
  - TTL: 3,600,000 ms.
- **GitHub Client**:
  - Uses `https.get` targeting strictly `https://api.github.com/repos/${REPO}/releases/latest`.
  - Header: `User-Agent: KhatamRouter-UpdateCheck`.
  - Timeout: 4,000 ms.
  - Fail-open error handling (returns `null` on any non-200, timeout, or parse failure).
  - If `releases/latest` returns 404, queries `https://api.github.com/repos/${REPO}/tags` taking the first tag.
- **Semver Compare**:
  - Strips leading `v` or whitespace.
  - Compares numerical `[major, minor, patch]`.
- **Runtime Detection**:
  - Inspects `fs.existsSync("/.dockerenv") || process.env.KHATAM_DOCKER === "1" || process.env.DATA_DIR === "/app/data"`.
  - Inspects `fs.existsSync(path.join(process.cwd(), ".git"))`.
  - Emits `runtime: "docker" | "git" | "standalone"`.
  - Emits `installCmd`:
    - Docker: `"docker compose pull && docker compose up -d"`
    - Git: `"git pull && bun install && bun run build:bun && bun run start:bun"`
    - Standalone: `null`

#### `src/app/api/version/update/route.js`
- Returns status `403` with JSON `{ success: false, message: "In-place package update is disabled in KhatamRouter. Please update via container or git pull." }`.

#### `src/lib/appUpdater.js` & `src/lib/updater/updater.js`
- Neutralize `spawnUpdaterAndExit` to fail closed with a safe log and no child process execution.
- Broaden `collectAppPids` to scan for both `9router` and `khatamrouter`.

#### `src/shared/components/Sidebar.js` & `src/shared/constants/config.js`
- Update `Sidebar.js` to consume `installCmd` from `/api/version` data if present, falling back to `UPDATER_CONFIG.gitInstallCmd` or `dockerInstallCmd`.
- Update modal title: `"Update KhatamRouter"`.
- Update `UPDATER_CONFIG` in `config.js` to reference KhatamRouter repository and eliminate `npmPackageName: "9router"`.

---

### 3.2 Task T2: CLI Branding & Dual Binary Alias

#### `cli/package.json`
- Keep `"name": "9router"`.
- Add binary alias:
  ```json
  "bin": {
    "9router": "./cli.js",
    "khatamrouter": "./cli.js"
  }
  ```
- Update `"description"` to `"KhatamRouter CLI - Start and manage KhatamRouter server (requires Bun runtime)"`.

#### `cli/cli.js`
- Update `checkForUpdate()`:
  - Check `process.env.KHATAM_UPDATE_CHECK === "0"` or `skipUpdate`.
  - Fetch from `api.github.com/repos/${KHATAM_UPDATE_REPO || 'rqzbeh/KhatamRouter'}/releases/latest` with 4s timeout.
  - Fail-open.
- Update `INSTALL_CMD_LATEST`:
  - Tailor to detected environment or GitHub release URL.
- Update CLI banners and tray messages:
  - `"Starting with Wave 7.5, KhatamRouter runs exclusively on Bun (bun:sqlite)"`
  - `"🔔 KhatamRouter is running in tray (PID: ...)"`
- Broaden process kill whitelist in `killAllAppProcesses`: match both `9router` and `khatamrouter`.

#### `cli/README.md`
- Header: `# KhatamRouter - Dual-Runtime AI Gateway & Proxy`.
- Quickstart instructions emphasize Docker (`ghcr.io/rqzbeh/khatamrouter:latest`) and local Bun runtime.

---

### 3.3 Task T3: Dashboard & Landing Display Branding

- Update `APP_CONFIG.name = "KhatamRouter"` in `src/shared/constants/config.js`.
- Update metadata in `src/app/layout.js` and `src/app/manifest.js`.
- Update heading in `src/app/login/page.js` to `<h1>KhatamRouter</h1>`.
- Update landing page components in `src/app/landing/` to reference KhatamRouter and link to `https://github.com/rqzbeh/KhatamRouter`.
- Update header descriptions in `src/shared/components/Header.js`.
- Preserve functional identifiers:
  - `~/.9router/` data dir stays intact.
  - CLI tools config keys (`model_providers.9router`, `provider["9router"]`, `custom:9Router-*`, etc.) remain fully parsed.
  - `status.has9Router` remains returned and checked.

---

### 3.4 Task T4: Documentation, Specs & Gates Audit

- Complete Spec-Kit package under `specs/011-branding-update-source/`.
- Complete Unlazy gates ledger under `.unlazy/011-branding-update-source/`.
- Ensure `gate-lint.mjs` executes with 0 errors.
- Ensure all existing unit tests in `tests/` pass with zero regressions.
