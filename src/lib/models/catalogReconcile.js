// Pure reconciliation core shared by runtime import, automatic sync and the
// maintainer script that regenerates the shipped default catalog.
//
// No I/O. Given the previous snapshot, a normalized listing, optional
// enrichment (for example models.dev) and manual overrides, it says what to
// add, update and remove. Callers persist the result.
//
// Rules this module enforces:
//   - remove only on a complete, authoritative, non-fallback listing
//   - a manual override always wins and protects its model from removal
//   - unknown stays unknown: a field the listing omits is never coerced to false,
//     and never downgrades a value we already hold
//   - output order is deterministic

export const FIELD_SOURCES = Object.freeze({
  LISTING: "listing",
  ENRICHMENT: "models.dev",
  MANUAL: "manual",
  UNKNOWN: "unknown",
});

// Fields that describe a model and can be reconciled.
const FIELDS = [
  "contextWindow",
  "maxOutputTokens",
  "supportsVision",
  "supportsTools",
  "supportsReasoning",
  "supportsAudio",
  "supportsVideo",
  "supportedThinkingEfforts",
];

// Capabilities a /models listing usually does not state. When the normalizer
// emits its default `false` for them we cannot tell "no" from "not said", so
// they only count as listed when the raw record actually carried a signal.
const ABSENT_MEANS_UNKNOWN = new Set([
  "supportsVision",
  "supportsTools",
  "supportsReasoning",
  "supportsAudio",
  "supportsVideo",
]);

// Credential-shaped keys only. A bare /token/ would also match legitimate
// fields such as maxOutputTokens, so tokens must be named like credentials.
const SECRET_KEY = /^(api[-_]?key|apikey|(access|refresh|auth|bearer|id|session)[-_]?token|token|secret|client[-_]?secret|password|passwd|authorization|credentials?)$/i;

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// An enrichment value counts only when it is a usable value for its field.
function isPresent(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Did the raw upstream record state this capability? Used for the fields whose
// normalizer default is `false`.
function rawStates(raw, field) {
  if (!isObj(raw)) return false;
  const text = JSON.stringify(Object.keys(raw)).toLowerCase();
  const hints = {
    supportsVision: ["modalit", "vision", "image", "architecture", "capabilit", "labels", "input"],
    supportsTools: ["tool", "function", "capabilit", "labels", "supported_parameters"],
    supportsReasoning: ["reason", "think", "capabilit", "labels", "supported_parameters"],
    supportsAudio: ["modalit", "audio", "architecture", "capabilit"],
    supportsVideo: ["modalit", "video", "architecture", "capabilit"],
  }[field] || [];
  return hints.some((h) => text.includes(h));
}

function stripSecrets(value, depth = 0) {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = stripSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Pull the reconcilable fields out of one normalized listing record. A field is
// returned only when the listing genuinely stated it.
function listedFields(record) {
  const out = {};
  for (const field of FIELDS) {
    const v = record[field];
    if (v === undefined || v === null) continue;
    if (field === "contextWindow" || field === "maxOutputTokens") {
      if (typeof v === "number" && v > 0) out[field] = v;
      continue;
    }
    if (field === "supportedThinkingEfforts") {
      if (Array.isArray(v) && v.length) out[field] = [...v];
      continue;
    }
    if (typeof v === "boolean") {
      if (v === true || !ABSENT_MEANS_UNKNOWN.has(field) || rawStates(record.raw, field)) out[field] = v;
    }
  }
  return out;
}

function cleanInvalid(models) {
  const byId = new Map();
  let invalid = 0;
  for (const rec of models) {
    if (!isObj(rec) || typeof rec.id !== "string" || !rec.id.trim()) {
      invalid++;
      continue;
    }
    byId.set(rec.id, rec); // last occurrence wins
  }
  return { byId, invalid };
}

function manualFieldsFor(overrides, id) {
  const entry = isObj(overrides) ? overrides[id] : null;
  const out = {};
  if (!isObj(entry)) return out;
  for (const [field, cell] of Object.entries(entry)) {
    if (isObj(cell) && cell.source === FIELD_SOURCES.MANUAL) out[field] = cell.value;
  }
  return out;
}

function pruneVerdict(listing) {
  if (!listing) return "no_listing";
  if (listing.fallback === true) return "fallback_listing";
  if (listing.complete !== true) return "incomplete_listing";
  const count = Array.isArray(listing.models) ? listing.models.length : 0;
  if (count === 0 && listing.authoritativeEmpty !== true) return "authoritative_empty_required";
  return null;
}

/**
 * @param {object} input
 * @param {Array<{id:string,lifecycle?:string,provenance?:string,capabilities?:object}>} [input.previous]
 * @param {{complete:boolean,authoritativeEmpty?:boolean,fallback?:boolean,models:Array<object>}|null} input.listing
 * @param {Record<string,object>} [input.enrichment]  per-model fields from a secondary source
 * @param {Record<string,Record<string,{value:any,source:string}>>} [input.overrides]
 */
export function reconcileCatalog({ previous = [], listing = null, enrichment = {}, overrides = {} } = {}) {
  const prevById = new Map();
  for (const p of Array.isArray(previous) ? previous : []) {
    if (isObj(p) && typeof p.id === "string") prevById.set(p.id, p);
  }

  const verdict = pruneVerdict(listing);
  const { byId: listed, invalid } = listing && Array.isArray(listing.models)
    ? cleanInvalid(listing.models)
    : { byId: new Map(), invalid: 0 };

  const add = [];
  const update = [];
  const unchanged = [];
  const remove = [];
  const stale = [];
  const divergences = [];

  // Additions and updates only make sense when we actually have models to read.
  for (const id of [...listed.keys()].sort()) {
    const record = listed.get(id);
    const prior = prevById.get(id);
    const fromListing = listedFields(record);
    const fromEnrichment = isObj(enrichment[id]) ? enrichment[id] : {};
    const manual = manualFieldsFor(overrides, id);

    const capabilities = {};
    const provenance = {};
    for (const field of FIELDS) {
      if (field in manual) {
        capabilities[field] = manual[field];
        provenance[field] = FIELD_SOURCES.MANUAL;
      } else if (field in fromListing) {
        capabilities[field] = fromListing[field];
        provenance[field] = FIELD_SOURCES.LISTING;
      } else if (isPresent(fromEnrichment[field])) {
        capabilities[field] = fromEnrichment[field];
        provenance[field] = FIELD_SOURCES.ENRICHMENT;
      } else if (prior?.capabilities && prior.capabilities[field] !== undefined) {
        capabilities[field] = prior.capabilities[field]; // never downgrade a known value
        provenance[field] = prior.provenance?.[field] || FIELD_SOURCES.LISTING;
      } else {
        provenance[field] = FIELD_SOURCES.UNKNOWN;
      }
    }

    for (const field of Object.keys(manual)) {
      if (field in fromListing && !sameValue(fromListing[field], manual[field])) {
        divergences.push({ id, field, manual: manual[field], discovered: fromListing[field] });
      }
    }

    const name = typeof record.name === "string" && record.name ? record.name : id;

    if (!prior) {
      add.push({ id, name, capabilities, provenance });
      continue;
    }

    const changes = {};
    for (const field of FIELDS) {
      if (field in manual) continue;
      if (capabilities[field] === undefined) continue;
      if (!sameValue(capabilities[field], prior.capabilities?.[field])) changes[field] = capabilities[field];
    }
    if (Object.keys(changes).length) update.push({ id, name, changes, capabilities, provenance });
    else unchanged.push({ id });
  }

  // Everything in the previous snapshot that this listing did not return.
  for (const id of [...prevById.keys()].sort()) {
    if (listed.has(id)) continue;
    const prior = prevById.get(id);
    const protectedByManual = Object.keys(manualFieldsFor(overrides, id)).length > 0 || prior.provenance === "manual";
    if (verdict !== null) continue; // not allowed to prune on this listing
    if (protectedByManual) {
      stale.push({ id });
      continue;
    }
    remove.push({ id });
  }

  const result = {
    add,
    update,
    unchanged,
    remove,
    stale,
    divergences,
    skipped: { prune: verdict, invalid },
  };
  // Defensive scrub: results are persisted, so nothing credential-shaped may ride along.
  return stripSecrets(result);
}
