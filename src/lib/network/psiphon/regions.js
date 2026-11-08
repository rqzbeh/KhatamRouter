/**
 * Documented Psiphon egress regions offered in the dashboard.
 *
 * This is a UI/selection list only: it does NOT restrict validation or the
 * rotation candidate pool. `validateRegion`/`validateRegions` stay format-based
 * (any ISO alpha-2 code) and `psiphonManager`'s DEFAULT_REGIONS is unchanged, so
 * an operator can still configure a country outside this list and the frozen
 * rotation behavior is unaffected.
 *
 * `BR` was added by regionhop v1.27.0 (2026-11-04) and needs that release or
 * newer in the pinned manifest (regionhopRelease.json) to exist upstream.
 *
 * Kept free of node: imports so the client dashboard can use it.
 */
export const PSIPHON_SELECTABLE_REGIONS = [
  "US",
  "CA",
  "NL",
  "DE",
  "GB",
  "FR",
  "JP",
  "SG",
  "BR",
];
