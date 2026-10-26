# Unlazy Plan: KhatamRouter Branding & Release Isolation

**Directory**: `.unlazy/011-branding-update-source`  
**Feature Branch**: `spec/011-branding-update-source`  
**Target Spec**: `specs/011-branding-update-source/spec.md`

---

## 1. Depth Tree & Decomposition

```
011-branding-update-source
├── T1: Update-Check API & Updater Neutralization
│   ├── /api/version GitHub releases feed + runtime detection
│   ├── /api/version/update fail-closed 403 response
│   ├── Neutralize appUpdater and updater.js
│   └── Dynamic Sidebar update modal & config presets
├── T2: CLI Branding & Binary Aliases
│   ├── cli/package.json bin aliases (9router + khatamrouter)
│   ├── cli/cli.js update check to GitHub releases
│   ├── Process cleanup matching 9router + khatamrouter
│   └── cli/README.md branding & quickstart
├── T3: Dashboard & Landing Display Branding
│   ├── App config, layout title, manifest, login heading
│   ├── Landing page components (Nav, Hero, HowItWorks, GetStarted, Footer)
│   ├── Dashboard tool card copy & topology node
│   └── Strict preservation of functional identifiers (data dir, tool keys)
└── T4: Documentation, Specs & Gates Audit
    ├── Spec-Kit SDD package (spec.md, plan.md, tasks.md, research.md)
    ├── Unlazy gates (PLAN.md, GATES.md)
    └── Zero gate-lint errors & regression verification
```

---

## 2. Leaves & Task Ownership

- **Leaf 1 (T1)**: Update-Check & Updater Neutralization
  - *Owns*: `src/app/api/version/route.js`, `src/app/api/version/update/route.js`, `src/lib/appUpdater.js`, `src/lib/updater/updater.js`, `src/shared/components/Sidebar.js`, `src/shared/constants/config.js`, `tests/unit/update-check-and-updater.test.js`
- **Leaf 2 (T2)**: CLI Branding & Binary Aliases
  - *Owns*: `cli/package.json`, `cli/cli.js`, `cli/README.md`, `tests/unit/cli-branding.test.js`
- **Leaf 3 (T3)**: Dashboard & Landing Display Branding
  - *Owns*: `src/app/layout.js`, `src/app/manifest.js`, `src/app/login/page.js`, `src/app/landing/components/Navigation.js`, `src/app/landing/components/HeroSection.js`, `src/app/landing/components/HowItWorks.js`, `src/app/landing/components/GetStarted.js`, `src/app/landing/components/Footer.js`, `src/app/landing/components/FlowAnimation.js`, `src/app/landing/page.js`, `src/shared/components/Header.js`, `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`, `src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js`, `src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js`, `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`, `src/shared/constants/cliTools.js`, `tests/unit/dashboard-display-branding.test.js`
- **Leaf 4 (T4)**: Documentation, Specs & Gates Audit
  - *Owns*: `specs/011-branding-update-source/**`, `.unlazy/011-branding-update-source/**`, `tests/unit/spec-docs-audit.test.js`
