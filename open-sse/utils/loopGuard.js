// Loop guard: stateless detection of repeating tool call patterns in conversation history.
// Analyzes messages array in the current request body - no cross-request state needed.
// Returns { detected: bool, hint: string|null }

const SINGLE_REPEAT_THRESHOLD = 3; // same tool+args appearing >= this many times
const SEQUENCE_REPEAT_THRESHOLD = 2; // same sequence of N tool calls appearing >= this many times
const MIN_SEQUENCE_LENGTH = 2; // minimum sequence length to detect
const MAX_SEQUENCE_LENGTH = 6; // maximum sequence length to detect (agent loops are tight cycles)
const RECENT_TOOL_WINDOW = 40; // only inspect the most recent tool calls (avoids O(N^4) on large sessions)
const RECENT_TEXT_WINDOW = 20; // only inspect the most recent assistant messages for text loops

// Text-loop detection thresholds (symptom: model repeats planning/intent text
// without ever making a tool call — e.g. "I need to read the key files..." 6×).
const TEXT_MESSAGE_REPEAT_THRESHOLD = 3; // same normalized assistant message >= this many times
const TEXT_SENTENCE_REPEAT_THRESHOLD = 3; // same sentence across all assistant msgs >= this many times
const MIN_TEXT_LENGTH = 12; // ignore tiny fragments (< this many chars) to avoid false positives

function sortObjectKeys(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortObjectKeys);
  const sorted = {};
  for (const k of Object.keys(val).sort()) {
    sorted[k] = sortObjectKeys(val[k]);
  }
  return sorted;
}

/**
 * Normalize tool call arguments for stable hashing:
 * Sort object keys recursively so {b:1,a:2} and {a:2,b:1} produce the same hash,
 * preserving nested object properties.
 */
function normalizeArgs(argsStr) {
  try {
    const obj = JSON.parse(argsStr);
    return JSON.stringify(sortObjectKeys(obj));
  } catch {
    return argsStr || "";
  }
}

function toolCallHash(tc) {
  const name = tc?.function?.name || tc?.name || "";
  const args = normalizeArgs(tc?.function?.arguments || tc?.arguments || "");
  return `${name}::${args}`;
}

/**
 * Extract all tool_call hashes from recent conversation history in order.
 * Scans from newest to oldest up to RECENT_TOOL_WINDOW calls to avoid O(N) serialization on large histories.
 */
function extractToolCallSequence(messages, maxCalls = RECENT_TOOL_WINDOW) {
  const seq = [];
  for (let i = messages.length - 1; i >= 0 && seq.length < maxCalls; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (let j = msg.tool_calls.length - 1; j >= 0; j--) {
        seq.unshift(toolCallHash(msg.tool_calls[j]));
        if (seq.length >= maxCalls) break;
      }
    }
  }
  return seq;
}

/**
 * Detect single tool call repeated >= SINGLE_REPEAT_THRESHOLD times.
 */
function detectSingleRepeat(seq) {
  const counts = new Map();
  for (const h of seq) {
    counts.set(h, (counts.get(h) || 0) + 1);
    if (counts.get(h) >= SINGLE_REPEAT_THRESHOLD) return h;
  }
  return null;
}

/**
 * Detect a sequence of N tool calls that repeats >= SEQUENCE_REPEAT_THRESHOLD times.
 * Uses sliding window to find N-gram repeats. Capped at MAX_SEQUENCE_LENGTH to avoid polynomial explosion.
 */
function detectSequenceRepeat(seq) {
  const n = seq.length;
  const maxLen = Math.min(MAX_SEQUENCE_LENGTH, Math.floor(n / 2));
  // Try sequence lengths from largest to smallest (greedy)
  for (let len = maxLen; len >= MIN_SEQUENCE_LENGTH; len--) {
    for (let start = 0; start <= n - len * 2; start++) {
      const pattern = seq.slice(start, start + len).join("|");
      let count = 0;
      let pos = 0;
      while (pos <= n - len) {
        const window = seq.slice(pos, pos + len).join("|");
        if (window === pattern) {
          count++;
          pos += len;
        } else {
          pos++;
        }
      }
      if (count >= SEQUENCE_REPEAT_THRESHOLD) return pattern;
    }
  }
  return null;
}

/**
 * Extract plain-text content from a single message (handles string + content-array).
 */
function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * Normalize text for stable comparison: lowercase, collapse whitespace, strip
 * trailing punctuation. Keeps internal words so semantic repeats still match.
 */
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

/**
 * Split text into sentence-ish chunks for finer-grained repeat detection.
 * Uses common sentence delimiters (incl. newlines for planning-style text).
 */
function splitSentences(text) {
  return String(text || "")
    .split(/[\n.!?…]+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= MIN_TEXT_LENGTH);
}

/**
 * Extract assistant message texts from recent conversation history in order.
 * Limited to RECENT_TEXT_WINDOW to avoid scanning and splitting thousands of historical sentences.
 */
function extractAssistantTexts(messages, maxCount = RECENT_TEXT_WINDOW) {
  const texts = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < maxCount; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      const t = messageText(msg);
      if (t.length >= MIN_TEXT_LENGTH) texts.unshift(t);
    }
  }
  return texts;
}

/**
 * Detect text-only reasoning loops (no tool calls involved).
 * Catches two patterns:
 *  1. Same assistant message repeated >= TEXT_MESSAGE_REPEAT_THRESHOLD times
 *     (e.g. model emits "Subagent gagal. Saya cek langsung." 6× across turns)
 *  2. Same sentence appearing >= TEXT_SENTENCE_REPEAT_THRESHOLD times across
 *     all assistant messages (e.g. "I need to read the key files..." in 3+ msgs)
 * @param {object[]} messages
 * @returns {{ detected: boolean, hint: string|null }}
 */
function detectTextRepeat(messages) {
  const texts = extractAssistantTexts(messages);
  if (texts.length < TEXT_MESSAGE_REPEAT_THRESHOLD) return { detected: false, hint: null };

  // 1. Exact message repeat (normalized)
  const msgCounts = new Map();
  for (const t of texts) {
    const norm = normalizeText(t);
    if (norm.length < MIN_TEXT_LENGTH) continue;
    const count = (msgCounts.get(norm) || 0) + 1;
    msgCounts.set(norm, count);
    if (count >= TEXT_MESSAGE_REPEAT_THRESHOLD) {
      return {
        detected: true,
        hint: "You have repeated the same response multiple times without making progress. This is a text loop — you are NOT moving forward. STOP repeating yourself. Either call a tool to act, or give your final answer now with the information you already have."
      };
    }
  }

  // 2. Sentence-level repeat across messages
  const sentenceCounts = new Map();
  for (const t of texts) {
    if (t.length > 4096) continue; // Skip sentence splitting on massive code/diff dumps
    const uniqueSentences = new Set(splitSentences(t));
    for (const s of uniqueSentences) {
      const count = (sentenceCounts.get(s) || 0) + 1;
      sentenceCounts.set(s, count);
      if (count >= TEXT_SENTENCE_REPEAT_THRESHOLD) {
        return {
          detected: true,
          hint: "You keep repeating the same planning statement without acting on it. STOP planning in circles. Either execute a tool call NOW, or provide your final answer with current knowledge. Do not restate your plan again."
        };
      }
    }
  }

  return { detected: false, hint: null };
}

/**
 * Main loop detection function.
 * @param {object} body - the translated request body (must have messages array)
 * @returns {{ detected: boolean, hint: string|null }}
 */
export function detectLoop(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { detected: false, hint: null };

  // Tool-call loop detection (existing)
  const seq = extractToolCallSequence(messages);
  if (seq.length >= SINGLE_REPEAT_THRESHOLD) {
    const singleRepeat = detectSingleRepeat(seq);
    if (singleRepeat) {
      return {
        detected: true,
        hint: "You have called the same tool with identical arguments multiple times with no new progress. STOP repeating. Summarize findings from existing results or change your strategy."
      };
    }

    const seqRepeat = detectSequenceRepeat(seq);
    if (seqRepeat) {
      return {
        detected: true,
        hint: "You have repeated the same sequence of tool calls multiple times. This is a loop. STOP this pattern immediately. Summarize what you have already found or take a completely different approach."
      };
    }
  }

  // Text-only loop detection (symptom 1: model repeats planning/intent text
  // without making tool calls — detectLoop's tool-call check misses this)
  const textLoop = detectTextRepeat(messages);
  if (textLoop.detected) return textLoop;

  return { detected: false, hint: null };
}

/**
 * Loop guard: detect repeated tool_call patterns in the translated conversation
 * history and, when found, append a stop-and-summarize hint to the last
 * user/tool/assistant message so the model breaks out of the loop.
 * Stateless — reads translatedBody.messages only. Idempotent: a hint already
 * present is not re-appended. Returns true when a hint was injected.
 */
export function applyLoopGuard(translatedBody, finalFormat, provider, model, log) {
  const loopCheck = detectLoop(translatedBody);
  if (!loopCheck.detected) return false;
  const msgs = translatedBody?.messages;
  if (Array.isArray(msgs)) {
    let target = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && (m.role === "user" || m.role === "tool")) {
        target = m;
        break;
      }
      // Text-only loop: last message is assistant (no user/tool after it).
      // Append the hint to the last assistant message so the model sees the
      // correction on its own repeated output.
      if (m && m.role === "assistant" && i === msgs.length - 1) {
        target = m;
        break;
      }
    }
    if (target) {
      const hint = `\n\n[ROUTER NOTE: ${loopCheck.hint}]`;
      if (typeof target.content === "string") {
        if (!target.content.includes("[ROUTER NOTE:")) target.content += hint;
      } else if (Array.isArray(target.content)) {
        if (!target.content.some((p) => p.text && p.text.includes("[ROUTER NOTE:")))
          target.content.push({ type: "text", text: hint });
      } else {
        target.content = hint.trimStart();
      }
    }
  }
  log?.warn?.("LOOPGUARD", `${provider}/${model} | loop detected, hint injected`);
  return true;
}

