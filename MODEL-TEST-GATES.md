# Gates: provider test-all hang

OWNS: src/lib/models/modelTestBatch.js, src/app/api/models/test-batch/**, src/app/api/models/test/ping.js, src/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js, tests/unit/model-test-*.test.js

Scope: Reproduce and fix provider Test All Models stuck at Batch 1 of 1 (42 models), with bounded probes, useful progress/cancellation and no real paid upstream calls during verification.

- [x] G1: A deterministic regression reproduces the reported pending-batch symptom before the fix and completes after the fix.
  CHECK: bun x --bun vitest run --root tests unit/model-test-batch-hang.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=ccfda4b4c77b8f63fe642f2241ed04b4360be11dea233bf33b638f0668a55f93; exit=0; EXPECT=matched; output-sha256=b87b57e2e4947fb06d6e79a9e95754468eabddcc7cfa07305ebadcedd36c33cd; output-bytes=4109; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G2: Model probes and UI requests settle or cancel within bounds; all 42 mocked models reach terminal results without a forever-pending batch.
  CHECK: bun x --bun vitest run --root tests unit/model-test-batch-hang.test.js unit/model-test-batch-route.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=999fad7e676e0a9e11a382b6c456ad450e463a86de2202259844db62aa269439; exit=0; EXPECT=matched; output-sha256=51c3d559c20f594fda99022e0e40348386db7141dc4bf6bbe883d859e9e6e413; output-bytes=10905; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G3: Provider routing, classification and opt-in safe auto-disable behavior retain passing regression coverage; targeted lint passes.
  CHECK: bun x --bun vitest run --root tests unit/model-test-batch-classification.test.js unit/model-test-batch-storm.test.js unit/model-test-disable-audit.test.js unit/model-test-parent-safety.test.js unit/model-test-routing.test.js unit/model-management-ui.test.js unit/model-management-classification.test.js unit/ping-reasoning-models-3010.test.js unit/provider-test-models-routing.test.js && bun x --bun eslint src/lib/models/modelTestBatch.js src/app/api/models/test-batch/route.js src/app/api/models/test/ping.js 'src/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js' tests/unit/model-test-batch-hang.test.js tests/unit/model-test-batch-route.test.js && git diff --check && printf 'MODEL_TEST_REGRESSIONS_OK\n'
  EXPECT: MODEL_TEST_REGRESSIONS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=c0192742e77294dec8a6bd776351395a1a5552b844f5ec1c7a7c44f245f08f87; exit=0; EXPECT=matched; output-sha256=79d8a2e177bd7d770d5aeab975af38866ca3dd19e81c3dffe53e55f3e9597936; output-bytes=7574; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G4: Parent review confirms no quota/auth bypass, no credentials in diagnostics, no live upstream verification, and accurate documentation of timeout/progress behavior.
  EVIDENCE: Parent reviewed idempotent lease release, bounded owned-reader cancellation, late-fetch cleanup, unresolved-probe stop, explicit NDJSON done enforcement and sanitized streaming errors. Independent 123 mocked regressions and lint passed; README/ROADMAP/CHANGELOG explain 15s bounds, actual progress and timeout non-disable behavior. Live provider tests were not used for feature verification.
