# Acceptance Gates: KhatamRouter Branding & Release Isolation

OWNS: specs/011-branding-update-source/**, .unlazy/011-branding-update-source/**, src/app/api/version/**, src/lib/appUpdater.js, src/lib/updater/**, src/shared/components/Sidebar.js, src/shared/constants/config.js, cli/package.json, cli/cli.js, cli/README.md, src/app/layout.js, src/app/manifest.js, src/app/login/page.js, src/app/landing/**, src/shared/components/Header.js, src/app/(dashboard)/dashboard/**, src/shared/constants/cliTools.js, tests/unit/**

- [x] G1: Spec-Kit SDD package and research inventory are fully documented
  CHECK: bun -e 'const fs=require("fs"); ["spec.md","plan.md","tasks.md","research.md"].forEach(f=>fs.statSync("specs/011-branding-update-source/"+f)); console.log("SPEC_011_G1_VALIDATED");' && echo SPEC_011_G1_PASS
  EXPECT: SPEC_011_G1_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=6b941c5f21d7afde1820569139b747a1880089897cd75467ded759abb9ca88a5; exit=0; EXPECT=matched; output-sha256=16da2b94ec96ec63a4cffa12072570f835ec7a9b769299bdd8af690a161fedc2; output-bytes=39; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/wf_3137c986-4ed-2; path=6d172f707922/32 entries

- [x] G2: Unlazy gates ledger passes gate-lint without findings
  CHECK: bun /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/011-branding-update-source/GATES.md && echo SPEC_011_G2_PASS
  EXPECT: SPEC_011_G2_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=adab7b649ba84f4c778df318f4b5bc125730e08c7a7ed17979d5817b7d9e5d3f; exit=0; EXPECT=matched; output-sha256=0cbf8399465490f97c5cd3c31d008439fed544136a55ee99ec22c5556c2ab25a; output-bytes=25; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/wf_3137c986-4ed-2; path=6d172f707922/32 entries

- [x] G3: Task file ownership sets are verified completely disjoint
  CHECK: bun -e 'const fs=require("fs"),t=fs.readFileSync("specs/011-branding-update-source/tasks.md","utf8"); const m=[...t.matchAll(/\| \*\*T\d\*\* \| [^|]+ \| ([^|]+) \|/g)].map(x=>x[1].split(",").map(s=>s.trim())); const seen=new Set(); for(const set of m){for(const f of set){if(seen.has(f))process.exit(1); seen.add(f);}} console.log("SPEC_011_G3_DISJOINT");' && echo SPEC_011_G3_PASS
  EXPECT: SPEC_011_G3_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=79148a54c4482ae79b7249e9a3cb41b321761e48e4ecdb33f93deb793f2d486b; exit=0; EXPECT=matched; output-sha256=a3e66a971a571ad8542be6a9bce238f7f4e9564c687ae1dcc6631321532b3451; output-bytes=38; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/wf_3137c986-4ed-2; path=6d172f707922/32 entries

- [x] G4: Functional identifiers and backward compatibility rules are preserved
  CHECK: bun -e 'const fs=require("fs"),r=fs.readFileSync("specs/011-branding-update-source/research.md","utf8"); const req=["~/.9router","model_providers.9router","provider[\"9router\"]","status.has9Router","urn:9router:sp"]; for(const k of req){if(!r.includes(k))process.exit(1);} console.log("SPEC_011_G4_PRESERVED");' && echo SPEC_011_G4_PASS
  EXPECT: SPEC_011_G4_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=82df1cba7341280ccfef3237e6f3fb1bd980fc196b45b34291fe570afc376118; exit=0; EXPECT=matched; output-sha256=e1edc16296b0827a4aee50aa80c05ad03eac09c478aadf62c770a903b7dd273b; output-bytes=39; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/wf_3137c986-4ed-2; path=6d172f707922/32 entries

- [x] G5: Baseline capabilities test suite passes under Bun without regressions
  CHECK: bun x vitest run unit/capabilities.test.js && echo SPEC_011_G5_PASS
  EXPECT: SPEC_011_G5_PASS
  CWD: ../../tests
  EVIDENCE: automatic-evidence=v1; definition-sha256=41de527a37aefc38b7bf0c9748b55d704653c084b0ceb9a4db9d75ca27d34830; exit=0; EXPECT=matched; output-sha256=7958e4553214d278d7a9cffa8075ba1c6b9216b792e8b8e0893b0600acc322b6; output-bytes=271; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/wf_3137c986-4ed-2/tests; path=6d172f707922/32 entries
