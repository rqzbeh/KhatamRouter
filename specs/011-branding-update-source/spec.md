# Specification: KhatamRouter Branding & Release Isolation

**Feature Branch**: `spec/011-branding-update-source`  
**Status**: Ready for Planning  
**Classification**: Security Hardening & Product Identity

---

## 1. Problem Statement & Scope

KhatamRouter is a standalone fork of `decolua/9router` running strictly on Bun with native `bun:sqlite` and Redis capabilities. However, residual upstream artifacts cause the application to identify as `9router` and check for updates against the upstream npm package `9router`. If a user acts on these update notices, the application either prompts them to run `npm i -g 9router@latest` or triggers an in-place auto-updater that overwrites the hardened KhatamRouter binary with upstream Node code.

This specification isolates the update feed to KhatamRouter's official releases, tailors update guidance to the actual running environment (Docker container vs Bun source), neutralizes the insecure in-place updater, and renames user-visible display elements to KhatamRouter while strictly preserving all existing functional identifiers and data persistence paths.

---

## 2. Requirements

### 2.1 Update Mechanism & Release Feed

- **FR-01: GitHub Releases Update Feed**
  - The endpoint `GET /api/version` and the CLI update checker (`cli/cli.js`) MUST check for updates against the GitHub Releases/Tags API of `rqzbeh/KhatamRouter`.
  - Host pinning: Network requests MUST target `api.github.com` exclusively. Off-host redirects MUST be rejected.
  - Request parameters: Maximum timeout of 4,000 ms; `User-Agent: KhatamRouter-UpdateCheck`; zero authorization headers or credentials sent.
  - Caching: In-memory cached result with a TTL of 3,600,000 ms (1 hour).
  - Fail-Open Policy: If the release lookup times out, fails with a network error, returns a 404 or rate-limit status, or returns invalid JSON, the response MUST resolve to `latestVersion: null` and `hasUpdate: false`.
  - Configuration:
    - Environment variable `KHATAM_UPDATE_REPO` MAY override the default repository slug (`"rqzbeh/KhatamRouter"`).
    - Environment variable `KHATAM_UPDATE_CHECK=0` MUST completely disable remote update checks and return `hasUpdate: false`.
  - Semver comparison: Versions MUST be compared using strict semantic versioning (`major.minor.patch`), stripping any leading `"v"` prefix.

- **FR-02: Runtime-Aware Update Guidance**
  - The system MUST detect its operational runtime:
    - **Docker**: Detected by existence of `/.dockerenv`, `process.env.KHATAM_DOCKER === "1"`, or `process.env.DATA_DIR === "/app/data"`.
    - **Git / Bun Source**: Detected by existence of `.git` directory in repo root.
    - **Standalone / Other**: Fallback mode.
  - The update guidance provided in `/api/version` response, the Sidebar modal, and the CLI interface menu MUST match the detected runtime:
    - Docker: `docker compose pull && docker compose up -d` (referencing `ghcr.io/rqzbeh/khatamrouter:latest`).
    - Bun Source: `git pull && bun install && bun run build:bun && bun run start:bun`.
    - Standalone: Direct the user to `https://github.com/rqzbeh/KhatamRouter/releases/latest`.
  - Under no circumstances shall the application generate guidance recommending `npm install -g khatamrouter` or `npm install -g 9router`.

- **FR-03: Neutralization of In-Place Auto-Updater**
  - The endpoint `POST /api/version/update` MUST return HTTP 403 Forbidden with a clear explanation that in-place package updates are disabled.
  - The function `spawnUpdaterAndExit` in `src/lib/appUpdater.js` and the standalone updater in `src/lib/updater/updater.js` MUST be neutralized fail-closed, ensuring no child process can spawn `npm i -g 9router` or execute upstream scripts.
  - Process cleanup helpers (`killAppProcesses` and `collectAppPids`) MUST be broadened to match both `9router` and `khatamrouter` process names.

### 2.2 Branding & User Experience

- **FR-04: Dashboard & Web UI Display Rebranding**
  - `src/shared/constants/config.js`: `APP_CONFIG.name` MUST be `"KhatamRouter"`.
  - `src/app/layout.js`: Document title metadata MUST be `"KhatamRouter - AI Infrastructure Management"`.
  - `src/app/manifest.js`: Web application manifest `name` and `short_name` MUST be `"KhatamRouter"`.
  - `src/app/login/page.js`: Header heading MUST be `"KhatamRouter"`.
  - `src/shared/components/Sidebar.js`: Modal title MUST be `"Update KhatamRouter"`.
  - `src/shared/components/Header.js`: Tooltip descriptions referencing `"9Router"` MUST reference `"KhatamRouter"`.
  - `src/app/landing/`: Navigation, Hero, HowItWorks, GetStarted, Footer, and FlowAnimation components MUST display `"KhatamRouter"` and link to `https://github.com/rqzbeh/KhatamRouter`.
  - `src/app/(dashboard)/dashboard/profile/page.js`: Default export filename MUST be `khatamrouter-backup-${stamp}.json`.
  - `src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`: Central topology node MUST be labeled `"KhatamRouter"`.
  - Dashboard tool cards (`AntigravityToolCard`, `MitmServerCard`, `MitmToolCard`, `CopilotToolCard`): Display labels and descriptions MUST reference `"KhatamRouter"`.

- **FR-05: CLI Tooling & Binary Aliases**
  - `cli/package.json`:
    - The `"bin"` field MUST provide dual entries: `"9router": "./cli.js"` AND `"khatamrouter": "./cli.js"`.
    - The `"name"` field MUST remain `"9router"` (preserving compatibility in the absence of an npm publish pipeline).
    - The `"description"` field MUST be updated to `"KhatamRouter CLI - Start and manage KhatamRouter server (requires Bun runtime)"`.
  - `cli/cli.js`:
    - All user-facing startup and background execution messages MUST display `"KhatamRouter"`.
    - Process cleanup filters MUST match both `9router` and `khatamrouter`.
  - `cli/README.md`:
    - Documentation title, headings, and quick start instructions MUST be updated to `"KhatamRouter"`.

### 2.3 Compatibility & Invariants

- **FR-06: Strict Preservation of Functional Identifiers**
  - **Data Directory**: The database, configuration, and log directories MUST remain `~/.9router/` (or `%APPDATA%/9router` on Windows) per CLAUDE.md persistence specifications.
  - **CLI Tool Integration Keys**: All CLI integration handlers (Codex, OpenCode, Droid, Crush, Pi, OMP, Copilot) MUST continue reading existing `9router` keys on disk. If `khatamrouter` keys are introduced, the parser MUST accept both.
  - **CLI Tools Status Contract**: Status responses from `/api/cli-tools/*` MUST continue returning `has9Router: boolean` (with an optional `hasKhatamRouter` alias).
  - **Backup Files**: The tool configuration backup suffix `*.bak-9router` MUST be preserved.
  - **SAML Issuer**: The default entity ID `urn:9router:sp` MUST remain accepted.

- **FR-07: Preservation of Attribution and Licensing**
  - `cli/LICENSE` MUST retain the original copyright notice for upstream contributors.
  - Historical lineage acknowledgments in `CHANGELOG.md` and documentation MUST remain intact.

---

## 3. Security & Non-Functional Invariants

1. **Supply-Chain Integrity**: No code path in KhatamRouter may fetch, install, or run packages from npm registry package `9router`.
2. **Credential Confidentiality**: Release lookups to GitHub MUST NOT send session tokens, API keys, or cookies.
3. **Availability & Fail-Open**: Inability to reach GitHub or rate limiting MUST NOT impede server boot, API routing, or dashboard access.
4. **Data Durability**: No user database, credential file, or usage log may be moved, renamed, or orphaned.
