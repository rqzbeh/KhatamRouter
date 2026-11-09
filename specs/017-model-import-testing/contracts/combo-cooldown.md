# Contract: Combo Failed-Member Cooldown

**Slice**: S2 · **Requirements**: FR-039..FR-046 · **Evidence**: `open-sse/services/combo.js`, commit `20a40ef8`, `fixtures/combo-cooldown/responses.json`, `src/lib/db/repos/combosRepo.js`

Extends the shipping scoped-cooldown implementation. MUST preserve the `20a40ef8` invariants: scope isolation, bounded map (`MAX_COOLDOWN_ENTRIES = 1000`), `parseRetryAfter` (numeric + HTTP-date + bounds), abort cleanup.

## Combo config (create/edit UI + API)

`POST/PUT /api/combos` accepts:
```json
{ "name": "my-combo", "models": ["openrouter/a", "openrouter/b"], "cooldownMs": 300000 }
```
- `cooldownMs` ∈ presets `{ 60000, 300000, 3600000 }` (or documented bounds); omitted = global default.
- Persisted on the combo (`combos` schema extension; `combosRepo`).
- **combosRepo SQL mapping (verified required)**: `src/lib/db/repos/combosRepo.js` must round-trip `cooldownMs` in all three places — `rowToCombo` return, `createCombo` INSERT columns/params, and `updateCombo` UPDATE SET. Today none of them include it; omitting any one means the value silently fails to persist or read back.
- Editing the combo invalidates rotation/cooldown state (existing `resetComboRotation`).

## Runtime behavior

| Requirement | Behavior |
|---|---|
| FR-040 skip in round-robin | A cooling member is skipped; selection routes to an eligible member or fails over promptly (no stall). |
| FR-041 silent restore | At expiry the member is eligible again with no operator action and no user-visible error. |
| FR-042 scope isolation | Cooldown key `` `${scope}::${comboName}::${modelStr}` ``; a failure in one scope never suppresses another. |
| FR-043 attribution | Account-level limit ≠ model-specific failure; only the correctly-scoped target is cooled. |
| FR-044 nested errors | Outer status wrapping an embedded upstream status (e.g. outer 503 + embedded 429) classifies on the **embedded** signal and honors the most reliable retry-after hint. |
| FR-045 conservative parse | Only well-formed, bounded hints honored; malformed/non-finite/absurd ignored; parsing never cools an unrelated member/combo/account/scope. |
| FR-046 no truncation | A long legitimate retry-after is not truncated to a shorter window; a short retry is not inflated into an unbounded stall. |

## Regression: real nested-limit failure (SC-014)

Fixture: outer `503` body carrying an embedded upstream `[429]` and a message like `daily free-model limit … reset 00:00 UTC` plus a `Retry after 11114 seconds` hint alongside other shorter nested reset hints.

Expected:
1. Fail over to an eligible combo member on the next request (no long stall on the failed member).
2. Cool down exactly the correctly-scoped member; respect the longest trustworthy hint (≈11114s, bounded by validation) without truncation.
3. Ignore malformed/conflicting hints; no unrelated scope cooled.

## Bounded / safe

- Map bounded and LRU-evicted (existing).
- `untilEpochMs` validated against `MAX_DATE_EPOCH`; no NaN/negative durations.
- No thundering herd at expiry: restoration is passive (eligibility window), not a queued retry burst.
