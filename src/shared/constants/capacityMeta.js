// Capability metadata for UI badges and combo aggregation in KhatamRouter.
// Single source of truth for modality visual markers, tooltip descriptions,
// and color tokens across provider tables, model selectors, and combo builders.

/**
 * @typedef {Object} ModelCapabilities
 * @property {boolean} vision
 * @property {boolean} pdf
 * @property {boolean} audioInput
 * @property {boolean} videoInput
 * @property {boolean} imageOutput
 * @property {boolean} audioOutput
 * @property {boolean} search
 * @property {boolean} tools
 * @property {boolean} reasoning
 * @property {string | null} thinkingFormat
 * @property {boolean} thinkingCanDisable
 * @property {{ min: number, max: number } | null} thinkingRange
 * @property {boolean} [thinkingEffortSupported]
 * @property {number} contextWindow
 * @property {number} maxOutput
 */

/**
 * @typedef {"vision" | "pdf" | "audioInput" | "videoInput" | "imageOutput" | "audioOutput" | "search" | "tools" | "reasoning"} ModalityKey
 */

/**
 * @typedef {Object} CapacityBadgeMeta
 * @property {ModalityKey} key
 * @property {string} icon - Google Material Symbols Outlined icon name
 * @property {string} label - Short human-readable label
 * @property {string} desc - Descriptive tooltip explanation
 * @property {string} color - Tailwind text color class
 * @property {string} bgClass - Tailwind background color class
 */

/**
 * 9 model modalities and features specified in Wave 8:
 * - vision: visibility, text-blue-500
 * - pdf: description, text-orange-500
 * - audioInput: mic, text-purple-500
 * - videoInput: videocam, text-rose-500
 * - imageOutput: image, text-emerald-500
 * - audioOutput: volume_up, text-indigo-500
 * - search: travel_explore, text-cyan-500
 * - tools: build, text-emerald-600
 * - reasoning: neurology, text-amber-500
 *
 * @type {Record<ModalityKey, CapacityBadgeMeta>}
 */
export const CAPACITY_META = {
  vision: {
    key: "vision",
    icon: "visibility",
    label: "Vision",
    desc: "Supports image input",
    color: "text-blue-500",
    bgClass: "bg-blue-500/10",
  },
  pdf: {
    key: "pdf",
    icon: "description",
    label: "PDF",
    desc: "Supports PDF and document input",
    color: "text-orange-500",
    bgClass: "bg-orange-500/10",
  },
  audioInput: {
    key: "audioInput",
    icon: "mic",
    label: "Audio In",
    desc: "Supports audio input",
    color: "text-purple-500",
    bgClass: "bg-purple-500/10",
  },
  videoInput: {
    key: "videoInput",
    icon: "videocam",
    label: "Video In",
    desc: "Supports video input",
    color: "text-rose-500",
    bgClass: "bg-rose-500/10",
  },
  imageOutput: {
    key: "imageOutput",
    icon: "image",
    label: "Image Out",
    desc: "Supports image generation",
    color: "text-emerald-500",
    bgClass: "bg-emerald-500/10",
  },
  audioOutput: {
    key: "audioOutput",
    icon: "volume_up",
    label: "Audio Out",
    desc: "Supports audio output",
    color: "text-indigo-500",
    bgClass: "bg-indigo-500/10",
  },
  search: {
    key: "search",
    icon: "travel_explore",
    label: "Search",
    desc: "Supports web search grounding",
    color: "text-cyan-500",
    bgClass: "bg-cyan-500/10",
  },
  tools: {
    key: "tools",
    icon: "build",
    label: "Tools",
    desc: "Supports function / tool calling",
    color: "text-emerald-600",
    bgClass: "bg-emerald-600/10",
  },
  reasoning: {
    key: "reasoning",
    icon: "neurology",
    label: "Reasoning",
    desc: "Supports reasoning / thinking",
    color: "text-amber-500",
    bgClass: "bg-amber-500/10",
  },
};

/** @type {ModalityKey[]} */
export const ORDERED_MODALITIES = [
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "imageOutput",
  "audioOutput",
  "search",
  "tools",
  "reasoning",
];

/**
 * Pure aggregation function for a list of resolved capability objects.
 * - Union: vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search
 * - Intersection: tools (active only if all models support tools)
 * - Primary: reasoning fields derived exclusively from the primary (first) model
 * - Conservative: contextWindow is minimum, maxOutput is maximum
 *
 * @param {(Partial<ModelCapabilities> | null)[]} [capsList] Array of capability dictionaries
 * @returns {ModelCapabilities | null} Aggregated capabilities object, or null for empty input
 */
export function aggregateCapabilities(capsList) {
  if (!capsList || !capsList.length) return null;
  const valid = capsList.filter(
    (c) => c !== null && typeof c === "object"
  );
  if (!valid.length) return null;

  const first = valid[0];
  const contextWindows = valid
    .map((c) => c.contextWindow)
    .filter((n) => typeof n === "number");
  const maxOutputs = valid
    .map((c) => c.maxOutput)
    .filter((n) => typeof n === "number");

  return {
    vision: valid.some((c) => Boolean(c.vision)),
    pdf: valid.some((c) => Boolean(c.pdf)),
    audioInput: valid.some((c) => Boolean(c.audioInput)),
    videoInput: valid.some((c) => Boolean(c.videoInput)),
    imageOutput: valid.some((c) => Boolean(c.imageOutput)),
    audioOutput: valid.some((c) => Boolean(c.audioOutput)),
    search: valid.some((c) => Boolean(c.search)),
    tools: valid.every((c) => c.tools !== false),
    reasoning: Boolean(first.reasoning),
    thinkingFormat: first.thinkingFormat ?? null,
    thinkingCanDisable: first.thinkingCanDisable ?? true,
    thinkingRange: first.thinkingRange ?? null,
    thinkingEffortSupported: first.thinkingEffortSupported ?? false,
    contextWindow: contextWindows.length ? Math.min(...contextWindows) : 200000,
    maxOutput: maxOutputs.length ? Math.max(...maxOutputs) : 64000,
  };
}
