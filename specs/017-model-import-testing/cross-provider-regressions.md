# Cross-provider correctness follow-ups

Created: 2026-11-08. Design and acceptance criteria owned by the main agent; bounded implementation delegated to workers, followed by independent parent tests and personal source review.

## Proxy response attribution

A bare HTTP403 is not evidence of proxy failure. Generic permission, credential, billing, model-access and policy failures must not quarantine an otherwise healthy pool. Words such as `geo`, `country`, `blocked` or the suffix `ip` inside another word are insufficient. Classify explicit source-IP denial or regional unavailability only within the provider scope, preserving upstream backoff, bounded parsing and fixed secret-free reasons. Connectivity of a proxy and usability of a provider through that proxy are distinct outcomes. No new retries or circumvention are introduced by attribution.

Parent baseline: 7 of 10 attribution cases failed on master; a subsequent negative control caught `Membership blocked` misread as `IP blocked` in the first fix. These are executable tests, not source-string checks.

## Schema-node traversal

A JSON Schema object and its `properties` dictionary are different structures. Transformation passes must visit each dictionary value as a schema, not apply schema mutations to the dictionary itself. The same rule applies to definition dictionaries and nested compositions. `enum`, `default` and example payloads are data, not schema nodes. Parameters legally named `items`, `type`, `required`, `properties`, `const`, `oneOf` or `anyOf` must retain their names and meanings.

Parent baseline: the actual cleaner emitted a string-valued `properties.type = "array"` for a nested parameter named `items`, reproducing the reported Google protobuf rejection class. Apply the fix to the shared cleaner and test every actual translator/executor caller; do not duplicate a provider-specific workaround.

## Live model picker grouping

Fetched provider models must participate in grouping for both passthrough and ordinary provider branches. An active provider with no static models (Zed is the reported case) must remain selectable when live discovery returns models. Use the same generic merge for every live-catalog provider, retaining canonical provider prefix, custom-entry deduplication, typed-modality filtering, inactive/disabled filtering and loading/error semantics.

Evidence currently shows fetched Zed models were consumed only by the non-passthrough branch although Zed is passthrough. An executable grouping/render regression must prove the visible result; grep-only tests do not establish this.

## Importer follow-up safety

Incomplete or malformed snapshots must never prune active records; completeness requires listing-adapter evidence rather than merely an HTTP200. Explicit false capabilities must update obsolete true values, while inferred unknowns must not downgrade them. Source retirement cannot delete a model still advertised by another active connection. Manual field metadata stays durable independently of source membership. Tests use real SQLite for these invariants.

Parent baseline: invalid-record pruning and explicit-false update tests failed; a separate real-DB test reproduced deletion of a custom model still advertised by a second connection. Follow-up fixes are required before importer completion is claimed.

## Production evidence

VPS log inspection is authorized read-only. Never print SSH keys, environment secrets, auth headers, provider credentials or customer request bodies. A reproduction of a failure class is not proof of the VPS root cause; record the deployed revision, log window and minimum sanitized signature. No production restart, deployment or tunnel rotation follows from inspection authority alone.
