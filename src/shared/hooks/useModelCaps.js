"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Resolve caps from a "provider/model" string or a bare model id.
// The seat prefix is a UI alias (ocg, cmc, …); the capability tables are keyed
// by provider id (opencode-go, commandcode, …), so map it before the lookup —
// an unmapped alias falls through to the generic patterns and under-reports
// (e.g. any *claude*haiku* id reads as 200k regardless of the provider entry).
export function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  const match = byFull?.[key] || (key.includes("/") ? byId?.[key.slice(key.indexOf("/") + 1)] : byId?.[key]);
  if (match) {
    return {
      supportsImageGeneration: null,
      supportsImageEditing: null,
      supportsWebSearch: null,
      supportsWebFetch: null,
      provenance: {},
      ...match,
      supportsVision: match.supportsVision ?? match.vision ?? false,
      supportsTools: match.supportsTools ?? match.tools ?? true,
      supportsReasoning: match.supportsReasoning ?? match.reasoning ?? false,
      supportsAudio: match.supportsAudio ?? match.audioInput ?? false,
      supportsVideo: match.supportsVideo ?? match.videoInput ?? false,
      supportsStreaming: match.supportsStreaming ?? true,
      imageOutput: match.imageOutput ?? Boolean(match.supportsImageGeneration),
      search: match.search ?? Boolean(match.supportsWebSearch),
      vision: match.vision ?? Boolean(match.supportsVision),
      reasoning: match.reasoning ?? Boolean(match.supportsReasoning),
      tools: match.tools ?? match.supportsTools ?? true,
    };
  }
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  const alias = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const provider = alias ? (ALIAS_TO_ID[alias] || alias) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    tools: c.tools !== false,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
    supportsVision: Boolean(c.vision),
    supportsTools: c.tools !== false,
    supportsReasoning: Boolean(c.reasoning),
    supportsAudio: Boolean(c.audioInput),
    supportsVideo: Boolean(c.videoInput),
    supportsStreaming: c.streaming !== false,
    supportsImageGeneration: c.imageOutput ? true : null,
    supportsImageEditing: null,
    supportsWebSearch: c.search ? true : null,
    supportsWebFetch: null,
    imageOutput: Boolean(c.imageOutput),
    audioInput: Boolean(c.audioInput),
    videoInput: Boolean(c.videoInput),
    thinkingFormat: c.thinkingFormat ?? null,
    provenance: {
      source: "fallback",
    },
    source: "default",
  };
}

export function invalidateModelCaps() {
  cache = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("customModelChanged"));
  }
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const sync = (maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    };
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    // Custom models change at runtime — drop the shared cache and refetch
    const invalidate = () => {
      cache = null;
      loadModelCaps().then(sync);
    };
    window.addEventListener("customModelChanged", invalidate);
    return () => {
      alive = false;
      window.removeEventListener("customModelChanged", invalidate);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
