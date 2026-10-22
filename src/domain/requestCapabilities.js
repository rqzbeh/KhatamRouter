/**
 * Request capability derivation and fail-closed compatibility gating (Wave 6).
 *
 * Analyses incoming user requests to derive capability requirements (vision,
 * tools, reasoning, token boundaries). Evaluates candidate models against
 * those requirements and enforces FAIL-CLOSED routing: an image request is
 * strictly prohibited from dispatching to an unconfirmed or non-vision target.
 */

import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

/** Hard capability requirements that must fail closed when unmet. */
export const HARD_CAPABILITY_REASONS = new Set(["vision", "tools", "output_tokens"]);

/** Operator flag for fail-closed combo capability gating (default OFF). */
export const CAPABILITY_GUARD_ENV = "KHATAM_MODEL_CAPABILITY_GUARD";

/**
 * Whether combo capability gating is enabled. Default-off so existing routing
 * behaviour is unchanged until an operator opts in.
 */
export function isCapabilityGuardEnabled(env = typeof process !== "undefined" ? process.env : {}) {
  const raw = env?.[CAPABILITY_GUARD_ENV];
  if (raw == null || raw === "") return false;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Trailing run of items after the last assistant/model turn (the current user turn).
 */
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

/**
 * Heuristically estimate input tokens from request content (~4 chars/token).
 */
function estimateTokensFromText(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function estimatePartTokens(part) {
  if (!part) return 0;
  if (typeof part === "string") return estimateTokensFromText(part);
  if (typeof part === "object") {
    if (typeof part.text === "string") return estimateTokensFromText(part.text);
    if (part.type === "image_url" || part.type === "image" || part.inlineData) return 1000; // heuristic image token estimate
  }
  return 0;
}

/**
 * Derive capability and resource requirements from an incoming request body.
 *
 * @param {object} body - incoming request JSON
 * @returns {{
 *   requiresVision: boolean,
 *   requiresTools: boolean,
 *   requiresReasoning: boolean,
 *   requiresPdf: boolean,
 *   requiresAudio: boolean,
 *   requiresVideo: boolean,
 *   estimatedInputTokens: number,
 *   requestedOutputTokens: number,
 *   requiredContextTokens: number,
 * }}
 */
export function deriveRequestRequirements(body) {
  const requirements = {
    requiresVision: false,
    requiresTools: false,
    requiresReasoning: false,
    requiresPdf: false,
    requiresAudio: false,
    requiresVideo: false,
    estimatedInputTokens: 0,
    requestedOutputTokens: 0,
    requiredContextTokens: 0,
  };

  if (!body || typeof body !== "object") return requirements;

  // 1. Tool requirements
  if (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0) ||
    body.tool_choice != null
  ) {
    requirements.requiresTools = true;
  }

  // 2. Reasoning requirements
  if (
    body.reasoning_effort != null ||
    body.thinking != null ||
    body.reasoning != null ||
    (body.thinking_budget != null && body.thinking_budget > 0)
  ) {
    requirements.requiresReasoning = true;
  }

  // 3. Modality scanning helper
  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) requirements.requiresVision = true;
    else if (mime === "application/pdf") requirements.requiresPdf = true;
    else if (mime.startsWith("audio/")) requirements.requiresAudio = true;
    else if (mime.startsWith("video/")) requirements.requiresVideo = true;
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") requirements.requiresVision = true;
    if (t === "input_audio" || t === "audio_url" || t === "audio") requirements.requiresAudio = true;
    if (t === "input_video" || t === "video_url" || t === "video") requirements.requiresVideo = true;
    if (t === "file" || t === "document" || t === "input_file") {
      let fmime = null;
      if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      if (fmime) addByMime(fmime);
      else requirements.requiresPdf = true;
    }
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) {
      for (const b of content) {
        scanBlock(b);
        requirements.estimatedInputTokens += estimatePartTokens(b);
      }
    } else if (typeof content === "string") {
      requirements.estimatedInputTokens += estimateTokensFromText(content);
      if (content.includes("data:image/")) requirements.requiresVision = true;
      if (content.includes("data:audio/")) requirements.requiresAudio = true;
      if (content.includes("data:application/pdf")) requirements.requiresPdf = true;
    }
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;
    if (Array.isArray(m.images) && m.images.length > 0) requirements.requiresVision = true;
    if (m.image_url || m.image) requirements.requiresVision = true;
    if (m.audio_url || m.audio) requirements.requiresAudio = true;

    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) requirements.requiresVision = true;
      }
    }

    scanContent(m.content);
  };

  // Modalities are scanned on current user turn
  for (const m of trailingUserItems(body.messages)) scanMessage(m);
  for (const it of trailingUserItems(body.input)) scanContent(it.content);
  const contents = body.contents || body.request?.contents;
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // 4. Output token bounds
  const rawMaxTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  requirements.requestedOutputTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
    ? Math.floor(rawMaxTokens)
    : 0;

  requirements.requiredContextTokens =
    requirements.estimatedInputTokens + requirements.requestedOutputTokens;

  return requirements;
}

/**
 * Resolve capability descriptor for a target model string or object.
 */
function resolveCaps(target) {
  if (!target) return { vision: false, tools: false, contextWindow: 0, maxOutput: 0 };

  if (typeof target === "object") {
    if (typeof target.supportsVision === "boolean" || typeof target.vision === "boolean") {
      return {
        vision: Boolean(target.supportsVision ?? target.vision),
        tools: Boolean(target.supportsTools ?? target.tools ?? true),
        contextWindow: target.contextWindow ?? target.context_window ?? 0,
        maxOutput: target.maxOutputTokens ?? target.maxOutput ?? 0,
      };
    }
  }

  const modelStr = typeof target === "string" ? target : target.modelStr || target.id || "";
  const slash = modelStr.indexOf("/");
  const provider = slash > 0 ? modelStr.slice(0, slash) : "";
  const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
  return getCapabilitiesForModel(provider, model);
}

/**
 * Vision Incompatibility Predicate.
 * Returns true if the request requires vision AND the target does not have confirmed vision support.
 */
export function isVisionIncompatibleTarget(target, requirements) {
  if (!requirements?.requiresVision) return false;
  const caps = resolveCaps(target);
  return caps.vision !== true;
}

/**
 * Evaluate all compatibility failures for a target against requirements.
 *
 * @param {string|object} target
 * @param {object} requirements
 * @returns {{ compatible: boolean, failures: string[] }}
 */
export function evaluateTargetCompatibility(target, requirements) {
  const failures = [];
  if (!requirements) return { compatible: true, failures };

  const caps = resolveCaps(target);

  // Vision requirement
  if (requirements.requiresVision && caps.vision !== true) {
    failures.push("vision");
  }

  // Tools requirement
  if (requirements.requiresTools && caps.tools === false) {
    failures.push("tools");
  }

  // Output token limit
  if (
    requirements.requestedOutputTokens > 0 &&
    caps.maxOutput > 0 &&
    requirements.requestedOutputTokens > caps.maxOutput
  ) {
    failures.push("output_tokens");
  }

  // Context window limit
  if (
    requirements.requiredContextTokens > 0 &&
    caps.contextWindow > 0 &&
    requirements.requiredContextTokens > caps.contextWindow
  ) {
    failures.push("context_window");
  }

  return {
    compatible: failures.length === 0,
    failures,
  };
}

/**
 * Filter combo candidate models according to capability requirements.
 * Enforces FAIL-CLOSED semantics for vision requests.
 *
 * @param {string[]} targets - Array of model strings
 * @param {object} requirements - Output of deriveRequestRequirements
 * @param {{ comboName?: string }} [options]
 * @returns {{ kept: string[], rejected: Array<{ model: string, failures: string[] }>, failClosed: boolean, error?: string }}
 */
export function filterCompatibleComboTargets(targets, requirements, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { kept: [], rejected: [], failClosed: false };
  }

  if (!requirements || !requirements.requiresVision) {
    // Non-vision requests pass all targets through
    return { kept: targets, rejected: [], failClosed: false };
  }

  const kept = [];
  const rejected = [];

  for (const target of targets) {
    const verdict = evaluateTargetCompatibility(target, requirements);
    if (verdict.compatible && !isVisionIncompatibleTarget(target, requirements)) {
      kept.push(target);
    } else {
      rejected.push({ model: target, failures: verdict.failures });
    }
  }

  if (kept.length === 0) {
    const name = options.comboName || "unnamed";
    return {
      kept: [],
      rejected,
      failClosed: true,
      error: `No target in combo ${name} has confirmed vision support for this image request`,
    };
  }

  return {
    kept,
    rejected,
    failClosed: false,
  };
}
