// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { DEFAULT_IMAGE_MIME, OPENAI_BLOCK } from "../schema/index.js";
import { isGemini4Model } from "../../providers/capabilities.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "deprecated", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
  // Non-standard annotation/error keywords used by some MCP tool schemas (#4283).
  // Gemini's schema proto has no field for these and rejects the whole request with
  // "Unknown name X: Cannot find field" if any nested schema node carries them.
  "errorMessage", "errorMessages", "x-errorMessage", "x-errorMessages",
  "markdownDescription", "x-intellij-html-description",
  "x-taplo-info", "x-taplo", "doNotSuggest", "suggestSortText",
  "minProperties", "maxProperties"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

function remoteImageMimeType(url) {
  let pathname;
  try { pathname = new URL(url).pathname.toLowerCase(); }
  catch { return DEFAULT_IMAGE_MIME; }
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".bmp")) return "image/bmp";
  return DEFAULT_IMAGE_MIME;
}

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: remoteImageMimeType(item.image_url.url) }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE && item.file?.file_data?.startsWith("data:")) {
        const url = item.file.file_data;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimeType = url.substring(5, commaIndex).split(";")[0];
          const data = url.substring(commaIndex + 1);
          parts.push({ inlineData: { mime_type: mimeType, data: data } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Dictionaries that map property/definition names to schema nodes.
// Transforms must NOT run on the dictionaries themselves; only on their values.
const SCHEMA_DICTIONARIES = ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"];

// Keywords whose values are an array of schema nodes
const SCHEMA_ARRAYS = ["anyOf", "oneOf", "allOf", "prefixItems"];

// Recurse each child schema of a schema node. Dictionaries and data are not traversed as schema nodes.
function forEachChildSchema(node, callback) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  for (const dictKey of SCHEMA_DICTIONARIES) {
    const dict = node[dictKey];
    if (dict && typeof dict === "object" && !Array.isArray(dict)) {
      for (const child of Object.values(dict)) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          callback(child);
        }
      }
    }
  }

  for (const arrKey of SCHEMA_ARRAYS) {
    const arr = node[arrKey];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          callback(item);
        }
      }
    }
  }

  if (node.items) {
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          callback(item);
        }
      }
    } else if (typeof node.items === "object") {
      callback(node.items);
    }
  }

  for (const singleKey of ["not", "additionalProperties", "contentSchema", "if", "then", "else"]) {
    const single = node[singleKey];
    if (single && typeof single === "object" && !Array.isArray(single)) {
      callback(single);
    }
  }
}

// Helper: Remove unsupported keywords recursively from schema nodes.
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini.
// Property dictionaries are NOT filtered against keywords, preserving parameters named after schema keywords.
function removeUnsupportedKeywords(node, keywords) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  forEachChildSchema(node, (child) => removeUnsupportedKeywords(child, keywords));

  for (const key of Object.keys(node)) {
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete node[key];
    }
  }
}

// Convert const to enum on schema nodes
function convertConstToEnum(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.const !== undefined && !node.enum) {
    node.enum = [node.const];
    delete node.const;
  }

  forEachChildSchema(node, convertConstToEnum);
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.enum && Array.isArray(node.enum)) {
    node.enum = node.enum.map(v => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!node.type) {
      node.type = "string";
    }
  }

  forEachChildSchema(node, convertEnumValuesToStrings);
}

// Merge allOf schemas
function mergeAllOf(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.allOf && Array.isArray(node.allOf)) {
    const merged = {};

    for (const item of node.allOf) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        mergeAllOf(item);
        if (item.properties && typeof item.properties === "object" && !Array.isArray(item.properties)) {
          if (!merged.properties) merged.properties = {};
          Object.assign(merged.properties, item.properties);
        }
        if (item.required && Array.isArray(item.required)) {
          if (!merged.required) merged.required = [];
          for (const req of item.required) {
            if (!merged.required.includes(req)) {
              merged.required.push(req);
            }
          }
        }
      }
    }

    delete node.allOf;
    if (merged.properties) node.properties = { ...node.properties, ...merged.properties };
    if (merged.required) node.required = [...(node.required || []), ...merged.required];
  }

  forEachChildSchema(node, mergeAllOf);
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  while (node.anyOf && Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    const nonNullSchemas = node.anyOf.filter(s => s && s.type !== "null");
    delete node.anyOf;
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      Object.assign(node, nonNullSchemas[bestIdx]);
    }
  }

  while (node.oneOf && Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    const nonNullSchemas = node.oneOf.filter(s => s && s.type !== "null");
    delete node.oneOf;
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      Object.assign(node, nonNullSchemas[bestIdx]);
    }
  }

  forEachChildSchema(node, flattenAnyOfOneOf);
}

// Flatten type arrays
function flattenTypeArrays(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.type && Array.isArray(node.type)) {
    const nonNullTypes = node.type.filter(t => t !== "null");
    if (nonNullTypes.length === 0) {
      node.type = "string";
    } else if (nonNullTypes.length === 1) {
      node.type = nonNullTypes[0];
    } else {
      // Multiple types: choose best fitting type (prefer structural clues then string over boolean/number)
      if (node.properties && nonNullTypes.includes("object")) {
        node.type = "object";
      } else if (node.items && typeof node.items === "object" && Object.keys(node.items).length > 0 && node.items.type && nonNullTypes.includes("array")) {
        node.type = "array";
      } else if (nonNullTypes.includes("string")) {
        node.type = "string";
      } else if (nonNullTypes.includes("number")) {
        node.type = "number";
      } else if (nonNullTypes.includes("integer")) {
        node.type = "integer";
      } else if (nonNullTypes.includes("boolean")) {
        node.type = "boolean";
      } else {
        node.type = nonNullTypes[0];
      }
    }
  }

  forEachChildSchema(node, flattenTypeArrays);
}

// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (node.properties && !node.type) {
    node.type = "object";
  }
  forEachChildSchema(node, ensureObjectType);
}

// Convert prefixItems (tuple validation) or array-of-items to items — Gemini cannot express tuples,
// and a type:"array" schema without items is rejected with "missing field"
function convertPrefixItems(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (Array.isArray(node.prefixItems) && node.prefixItems.length > 0) {
    const variants = node.prefixItems.filter(s => s && s.type !== "null");
    if (!node.items && variants.length === 1) {
      node.items = variants[0];
    } else if (!node.items && variants.length > 1) {
      node.items = { anyOf: variants };
    }
    delete node.prefixItems;
  }

  if (Array.isArray(node.items)) {
    const variants = node.items.filter(s => s && s.type !== "null");
    if (variants.length === 1) {
      node.items = variants[0];
    } else if (variants.length > 1) {
      node.items = { anyOf: variants };
    } else {
      node.items = { type: "string" };
    }
  }

  forEachChildSchema(node, convertPrefixItems);
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.items && node.type !== "array") {
    if (node.type === undefined && !node.properties) node.type = "array";
    else delete node.items;
  }
  if (node.type === "array") {
    if (!node.items || typeof node.items !== "object" || Object.keys(node.items).length === 0) {
      node.items = { type: "string" };
    } else if (!node.items.type) {
      if (node.items.properties) {
        node.items.type = "object";
      } else if (node.items.items) {
        node.items.type = "array";
      } else {
        node.items.type = "string";
      }
    }
  }

  forEachChildSchema(node, ensureArrayItems);
}

// Gemini Schema proto validation rules:
// 1. Schema.items predicate: $type == Type.ARRAY. If type is not "array", items field MUST NOT exist.
// 2. Schema.properties / required predicate: $type == Type.OBJECT. If type is not "object", properties and required MUST NOT exist.
function enforceTypeConstraints(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  forEachChildSchema(node, enforceTypeConstraints);

  if (node.type === "array") {
    delete node.properties;
    delete node.required;
    if (!node.items || typeof node.items !== "object" || Array.isArray(node.items) || Object.keys(node.items).length === 0) {
      node.items = { type: "string" };
    } else if (!node.items.type) {
      if (node.items.properties) {
        node.items.type = "object";
      } else if (node.items.items) {
        node.items.type = "array";
      } else {
        node.items.type = "string";
      }
    }
  } else {
    // Non-array schemas MUST NOT carry items
    delete node.items;
  }

  if (node.type !== "object") {
    delete node.properties;
    delete node.required;
  }
}

// Cleanup required fields recursively
function cleanupRequired(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (node.required && Array.isArray(node.required) && node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    const validRequired = node.required.filter(field =>
      Object.prototype.hasOwnProperty.call(node.properties, field)
    );
    if (validRequired.length === 0) {
      delete node.required;
    } else {
      node.required = validRequired;
    }
  }

  forEachChildSchema(node, cleanupRequired);
}

// Add placeholder for empty object schemas (Antigravity requirement)
function addPlaceholders(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  // Empty schema {} (no type, no properties) after $ref removal — treat as object with placeholder
  if (Object.keys(node).length === 0) {
    node.type = "object";
    node.properties = {
      reason: {
        type: "string",
        description: "Brief explanation of why you are calling this tool"
      }
    };
    node.required = ["reason"];
    return;
  }

  if (node.type === "object") {
    if (!node.properties || Object.keys(node.properties).length === 0) {
      node.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool"
        }
      };
      node.required = ["reason"];
    }
  }

  forEachChildSchema(node, addPlaceholders);
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  addPlaceholders(cleaned);

  // Phase 6: Enforce Gemini protobuf type predicates (items only on array, properties/required only on object)
  enforceTypeConstraints(cleaned);

  return cleaned;
}

// Gemini / Cloud Code treat a `$ref` key inside functionResponse.response as a
// pointer to functionResponse.parts and reject the request with
// "The referenced name `#/$defs/...` in function_response.response does not match
// to a display_name in the function_response.parts". Tool results that carry a
// JSON Schema / OpenAPI document (webfetch, read, MCP) hit this, so rename the key.
export const GEMINI_RESERVED_RESPONSE_KEYS = { "$ref": "_ref" };

const hasReservedKey = (value) =>
  Object.keys(value).some((key) => Object.hasOwn(GEMINI_RESERVED_RESPONSE_KEYS, key));

// Recursively rename reserved keys in tool-result payload (arrays/objects only).
// map is read with Object.hasOwn: payload key named "constructor" must stay
// "constructor", not be rewritten to Object.prototype's function source via `??`
// on an inherited hit.
export function sanitizeFunctionResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeFunctionResponsePayload);
  if (!value || typeof value !== "object") return value;
  // Untouched payloads (the overwhelming majority) return by reference: no clone.
  if (!hasReservedKey(value) && !Object.values(value).some((v) => v && typeof v === "object")) {
    return value;
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const mapped = Object.hasOwn(GEMINI_RESERVED_RESPONSE_KEYS, key)
      ? GEMINI_RESERVED_RESPONSE_KEYS[key]
      : key;
    // defineProperty, not `out[mapped] =`: a client-supplied "__proto__" key would
    // otherwise hit the prototype setter, silently dropping the key and giving the
    // output a non-standard prototype. defineProperty always makes an own property.
    Object.defineProperty(out, mapped, {
      value: sanitizeFunctionResponsePayload(val),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// Return the part with a sanitized functionResponse.response (same reference when untouched)
function sanitizeFunctionResponsePart(part) {
  const response = part?.functionResponse?.response;
  if (!response || typeof response !== "object") return part;
  return { ...part, functionResponse: { ...part.functionResponse, response: sanitizeFunctionResponsePayload(response) } };
}

// Gemini 4 rejects a merged user turn whose last part is not a functionResponse (#4802)
function moveFunctionResponsesLast(parts) {
  const responses = parts.filter(p => p.functionResponse);
  if (!responses.length) return parts;
  return [...parts.filter(p => !p.functionResponse), ...responses];
}

// Merge adjacent same-role messages, strip empty parts, ensure initial and terminal user turns
export function normalizeGeminiContents(contents, model = null) {
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0).map(sanitizeFunctionResponsePart);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      last.parts.push(...parts);
      if (frLast) last.parts = moveFunctionResponsesLast(last.parts);
    } else out.push({ ...c, parts: [...parts] });
  }
  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }
  if (out.length > 0 && out.at(-1).role === "model") {
    const fnCalls = (out.at(-1).parts || []).filter(p => p && p.functionCall);
    if (fnCalls.length > 0) {
      const responses = fnCalls.map(p => {
        const call = p.functionCall || {};
        const fr = {
          name: call.name || "tool",
          response: { result: "Continue." }
        };
        if (call.id) fr.id = call.id;
        return { functionResponse: fr };
      });
      out.push({ role: "user", parts: responses });
    } else {
      out.push({ role: "user", parts: [{ text: "Continue." }] });
    }
  }
  return out;
}


