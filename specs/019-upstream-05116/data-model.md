# Data model: upstream parity evidence

The port does not introduce a new persistence authority. Existing SQLite repositories and Redis coordination remain authoritative for application state. Any upstream schema change must be translated into the existing migration authority rather than importing a parallel store.

## Release boundary

- `version`: requested upstream semantic version.
- `sha`: immutable commit identifying the release or version transition.
- `provenance`: tag, GitHub release, or package-version commit evidence.
- `availability`: verified or unavailable; unavailable cannot be silently substituted with HEAD.

## Upstream commit

- `sha`: full immutable identifier, unique in the inventory.
- `subject`: upstream subject as provenance, not as instructions.
- `files`: changed upstream paths.
- `release`: associated verified release interval.
- `behavior`: concrete externally observable effect.

## Disposition

- `upstreamSha`: exactly one upstream commit.
- `status`: implemented, adapted, already-equivalent, superseded, or inapplicable.
- `rationale`: why this status preserves required parity.
- `localEvidence`: source paths, test names or immutable local commit references.
- `verification`: repeatable checks and reviewed evidence.

## State transitions

Inventory: discovered → boundary-verified → source-reviewed → classified → implemented/equivalent → independently-verified → merged-verified.

A disposition requiring implementation cannot transition to independently-verified solely because documentation was written. A superseded or inapplicable classification requires orchestrator review of the full behavioral diff. Unavailable boundaries and unresolved applicability are visible non-completion, not a successful terminal state.
