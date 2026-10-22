/**
 * Failure classification for upstream errors (Wave 4).
 *
 * Two jobs:
 *
 * 1. Split HTTP 429 into "short rate-limit window" and "long quota exhaustion".
 *    The status alone cannot say which; only the body can. Getting this wrong
 *    is expensive in both directions: treating exhaustion as a rate limit
 *    retries a dead credential for hours, and treating a burst limit as
 *    exhaustion locks a healthy account for an hour.
 *
 * 2. Decide whether a failure may count against provider health at all.
 *    Client-induced 4xx, content-policy refusals, our own stream-controller
 *    errors and local host-execution errors all say something about *this
 *    request* or *this process*, never about the upstream provider.
 *
 * Every regex here is matched against an attacker-influenced string, so all of
 * them use bounded or fixed alternations — no unbounded `.*` runs (FR-020).
 * Classification is pure and synchronous: it never throws and never does I/O.
 */

import { FAILURE_KIND, NON_TRIPPING_STATUS_SET, POLICY_FAILURE_PATTERN, QUOTA_SCALE_RETRY_SECONDS } from "open-sse/config/resilienceConfig.js";

/**
 * Bodies stating the account is out of credits or over a billing cap. These do
 * not clear on a timer, so they stay `quota_exhausted` whatever retry hint the
 * upstream attaches.
 */
const TERMINAL_QUOTA_PATTERNS = [
  /insufficient[_\s-]+(?:credits?|balance|quota|funds)/i,
  /credit(?:s)?[_\s-]*(?:balance[_\s-]*)?exhaust/i,
  /exhaust(?:ed)?\s+(?:all\s+)?(?:your\s+)?credits/i,
  /out\s+of\s+credits/i,
  /billing[_\s-]*(?:cap|hard[_\s-]*limit)/i,
  /individual\s+quota\s+reached/i,
  /enable\s+overages/i,
  /spend(?:ing)?[_\s-]*limit\s+(?:reached|exceeded)/i,
];

/**
 * Long-period quota wording. A 429 carrying any of these is exhaustion, not a
 * burst limit.
 */
const QUOTA_PATTERNS = [
  /daily\s+(?:request|token|usage|free)?[_\s-]*(?:limit|quota|allocation)/i,
  /per[_\s-]*day\s+limit/i,
  /monthly\s+(?:request|token|usage)?[_\s-]*(?:limit|quota)/i,
  /per[_\s-]*month\s+limit/i,
  /requests?\s*\/\s*month/i,
  /calls?\s*\/\s*month/i,
  /organization\s+tpd\s+rate\s+limit/i,
  /\bTPD\s+rate\s+limit\b/i,
  /quota[_\s-]*(?:exceed|exhaust|reach)/i,
  /(?:exceed|exhaust|reach)\w*\s+(?:your\s+|the\s+)?(?:daily\s+|monthly\s+)?quota/i,
  /resource\s+exhausted/i,
  /resets?\s+over\s+(?:a\s+)?rolling\s+24[-\s]?hour/i,
  /used\s+(?:all|up)\s+(?:the\s+)?(?:included\s+)?free\s+(?:usage|allocation|tier)/i,
  /all\s+credentials\s+.*\s+cooling\s+down/i,
  /model[_\s-]*cooldown/i,
  /auth\s+unavailable:\s+.*\s+in\s+cooldown/i,
  /usage\s+limit\s+reached/i,
];

/**
 * Quota-exhaustion wording in Chinese and Korean, which several providers
 * (GLM/z.ai, Kimi, Qwen, MiniMax) return in the body of a 429.
 */
const CJK_QUOTA_PATTERNS = [
  /额度已?用完/, // quota used up
  /配额已?(?:用完|超出|耗尽)/, // quota used up / exceeded / exhausted
  /超出(?:了)?(?:当日|本月|配额|额度)/, // exceeded daily/monthly quota
  /限额(?:已)?(?:用完|超出)/, // limit used up / exceeded
  /할당량을\s*초과/, // quota exceeded
  /사용\s*한도를\s*초과/, // usage limit exceeded
];

/**
 * Concurrency wording: the account is healthy, just busy. Reported separately
 * from `FailureKind` on purpose — the breaker still reads such a 429 as
 * `rate_limit`, but account fallback may prefer a sibling connection.
 */
const CONCURRENCY_PATTERNS = [
  /too\s+many\s+(?:concurrent|simultaneous|parallel)\s+(?:requests?|connections?|sessions?|calls?)/i,
  /concurrent\s+(?:requests?|connections?|sessions?)\s+(?:limit|exceeded|quota)/i,
  /max(?:imum)?\s+(?:number\s+of\s+)?concurrent\s+(?:requests?|streams?)/i,
];

/** Relative-duration fragment accepted inside a compound expression. */
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/gi;

/**
 * Coerce a response body into scannable text.
 * Strings pass through; objects are stringified so nested `error.message`
 * wording is seen; anything else becomes the empty string.
 */
export function bodyToText(body) {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    const text = JSON.stringify(body);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** True when the body states a long-period quota is exhausted. */
export function looksLikeQuotaExhausted(body) {
  const text = bodyToText(body);
  if (!text) return false;
  return (
    QUOTA_PATTERNS.some((pattern) => pattern.test(text)) ||
    CJK_QUOTA_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/** True when the body states a terminal credits/billing exhaustion. */
export function looksLikeTerminalQuotaExhaustion(body) {
  const text = bodyToText(body);
  if (!text) return false;
  return TERMINAL_QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True for a 429 whose wording describes concurrency pressure rather than a
 * spent budget. Deliberately false when an explicit quota phrase is also
 * present: exhaustion outranks "busy".
 */
export function looksLikeConcurrencyLimit(body) {
  const text = bodyToText(body);
  if (!text) return false;
  if (!CONCURRENCY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return !looksLikeQuotaExhausted(text) && !looksLikeTerminalQuotaExhaustion(text);
}

/** Case-insensitive header lookup that also accepts a `Headers` instance. */
export function getHeader(headers, name) {
  if (!headers) return undefined;
  const target = String(name).toLowerCase();
  try {
    const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
    for (const [key, value] of entries) {
      if (String(key).toLowerCase() === target) return value == null ? undefined : String(value);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parse a duration token into seconds.
 * Accepts `ms`/`s`/`m`/`h` suffixes and bare numbers (seconds).
 */
function parseDelaySeconds(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const single = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text);
  if (!single) return null;
  const amount = Number.parseFloat(single[1]);
  if (!Number.isFinite(amount)) return null;
  switch ((single[2] || "s").toLowerCase()) {
    case "ms": return amount / 1000;
    case "m": return amount * 60;
    case "h": return amount * 3600;
    default: return amount;
  }
}

/**
 * Upstream-declared retry window in seconds, when the body carries one.
 *
 * Google APIs attach a `google.rpc.RetryInfo` detail with an exact duration and
 * frequently repeat it as "Please retry in 38.9s" in the message. A short
 * declared window is strong evidence the throttle clears on its own.
 */
export function upstreamRetryDelaySeconds(body) {
  if (body == null) return null;
  const text = bodyToText(body);
  if (!text) return null;

  // Structured Google RetryInfo detail.
  try {
    const root = JSON.parse(text);
    const errorRecord = root && typeof root === "object" && root.error && typeof root.error === "object" ? root.error : null;
    const details = errorRecord?.details ?? (root && typeof root === "object" ? root.details : null);
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (!detail || typeof detail !== "object") continue;
        const type = String(detail["@type"] || "");
        if (!type.includes("RetryInfo")) continue;
        const raw = detail.retryDelay;
        const declared = typeof raw === "string" && /^(\d+(?:\.\d+)?)s$/.test(raw.trim())
          ? Number.parseFloat(raw)
          : parseDelaySeconds(raw);
        if (declared != null && Number.isFinite(declared) && declared >= 0) return declared;
      }
    }
    const message = errorRecord?.message;
    if (typeof message === "string") {
      const phrase = /please\s+retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i.exec(message);
      if (phrase) return Number.parseFloat(phrase[1]);
    }
  } catch {
    // Not JSON; fall through to the plain-text phrase scan.
  }

  const phrase = /please\s+retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (phrase) return Number.parseFloat(phrase[1]);

  // Compound human durations, e.g. "retry after 1h2m3s" / "resets in 2h 30m".
  const compound = /(?:retry|resets?|try\s+again)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*){2,})/i.exec(text);
  if (compound) {
    let total = 0;
    DURATION_PART.lastIndex = 0;
    let part;
    while ((part = DURATION_PART.exec(compound[1])) !== null) {
      const value = Number.parseFloat(part[1]);
      const unit = part[2].toLowerCase();
      total += unit === "ms" ? value / 1000 : unit === "m" ? value * 60 : unit === "h" ? value * 3600 : value;
    }
    if (total > 0) return total;
  }

  return null;
}

/**
 * Parse a `Retry-After` header into seconds.
 *
 * Accepts integer seconds, an HTTP date, and relative forms such as `60s`,
 * `5m`, `2h`. The relative form is checked first on purpose: `parseInt("5m")`
 * silently yields 5, turning a five-minute hint into five seconds.
 */
export function parseRetryAfter(headerValue) {
  if (headerValue == null) return null;
  const text = String(headerValue).trim();
  if (!text) return null;

  const relative = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(text);
  if (relative) {
    const amount = Number.parseFloat(relative[1]);
    if (!Number.isFinite(amount)) return null;
    switch (relative[2].toLowerCase()) {
      case "ms": return amount / 1000;
      case "m": return amount * 60;
      case "h": return amount * 3600;
      default: return amount;
    }
  }

  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);

  const parsedDate = Date.parse(text);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, (parsedDate - Date.now()) / 1000);
  }
  return null;
}

/** Retry-After seconds from a response-like `{ headers }` object. */
export function retryAfterFromResponse(response) {
  const header = getHeader(response && response.headers, "retry-after");
  return parseRetryAfter(header);
}

/**
 * Classify a response into a `FailureKind`.
 *
 * Decision order (locked; see spec US2):
 *   1. status < 400                              → transient
 *   2. terminal credits/billing wording           → quota_exhausted (any status)
 *   3. non-429                                    → transient
 *   4. declared retry window under an hour        → rate_limit
 *   5. quota wording                              → quota_exhausted
 *   6. otherwise                                  → rate_limit
 */
export function classify429(response) {
  const status = Number(response && response.status);
  if (!Number.isFinite(status) || status < 400) return FAILURE_KIND.TRANSIENT;

  const body = response ? response.body : undefined;
  if (looksLikeTerminalQuotaExhaustion(body)) return FAILURE_KIND.QUOTA_EXHAUSTED;

  if (status !== 429) return FAILURE_KIND.TRANSIENT;

  const declaredDelay = upstreamRetryDelaySeconds(body);
  if (declaredDelay != null && declaredDelay < QUOTA_SCALE_RETRY_SECONDS) {
    return FAILURE_KIND.RATE_LIMIT;
  }
  if (looksLikeQuotaExhausted(body)) return FAILURE_KIND.QUOTA_EXHAUSTED;
  return FAILURE_KIND.RATE_LIMIT;
}

/**
 * Classify a thrown error, when it carries enough shape to do so:
 *   - `err.status` + `err.headers` + `err.body`   (fetch wrapper)
 *   - `err.response.{status,headers,data|body}`   (axios-style)
 *   - `err.message`                               (keyword scan only)
 * Returns `undefined` when no status can be found — the caller then decides
 * without a kind tag rather than guessing.
 */
export function classify429FromError(error) {
  if (error == null || typeof error !== "object") return undefined;
  let status;
  let headers;
  let body;

  const response = error.response && typeof error.response === "object" ? error.response : null;
  if (response) {
    if (typeof response.status === "number") status = response.status;
    if (response.headers && typeof response.headers === "object") headers = response.headers;
    if (response.data !== undefined) body = response.data;
    else if (response.body !== undefined) body = response.body;
  }
  if (typeof error.status === "number") status = status ?? error.status;
  if (typeof error.statusCode === "number") status = status ?? error.statusCode;
  if (!headers && error.headers && typeof error.headers === "object") headers = error.headers;
  if (body === undefined) {
    if (error.body !== undefined) body = error.body;
    else if (error.error !== undefined) body = error.error;
    else if (typeof error.message === "string") body = error.message;
  }

  if (typeof status !== "number") return undefined;
  return classify429({ status, headers, body });
}

/**
 * Our own stream plumbing failing: enqueue-after-close on a controller we own,
 * or a caller that walked away. These carry no upstream status and must never
 * blacklist a provider.
 */
export function isLocalStreamLifecycleError(error) {
  if (!error) return false;
  const name = typeof error === "object" && typeof error.name === "string" ? error.name : "";
  if (name === "AbortError") return true;

  const message = typeof error === "string"
    ? error
    : typeof error === "object" && typeof error.message === "string"
      ? error.message
      : "";
  if (!message) return false;
  return (
    /controller is already closed/i.test(message) ||
    /request_signal_aborted/i.test(message) ||
    /client disconnected/i.test(message) ||
    /operation was aborted/i.test(message) ||
    /premature close/i.test(message)
  );
}

const LOCAL_EXECUTION_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EPIPE",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);

const LOCAL_EXECUTION_PATTERNS = [
  /\bspawn\b.{0,40}\b(?:ENOENT|EACCES|EPERM|EPIPE)\b/i,
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bchild process exited with code\b/i,
  /\blocal host execution error\b/i,
];

/** Local host-execution failure (missing binary, permission, broken pipe). */
export function isLocalExecutionError(error) {
  if (!error) return false;
  if (typeof error === "object") {
    const code = typeof error.code === "string" ? error.code : "";
    if (LOCAL_EXECUTION_CODES.has(code)) return true;
  }
  const message = typeof error === "string"
    ? error
    : typeof error === "object" && typeof error.message === "string"
      ? error.message
      : "";
  if (!message) return false;
  return LOCAL_EXECUTION_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when the error/text looks like a content-policy or moderation refusal. */
export function isPolicyRefusal(error) {
  if (!error) return false;
  const message = typeof error === "string"
    ? error
    : typeof error === "object" && typeof error.message === "string"
      ? error.message
      : typeof error === "object" && error.body !== undefined
        ? bodyToText(error.body)
        : "";
  if (!message) return false;
  return POLICY_FAILURE_PATTERN.test(message);
}

/**
 * True when a failure is allowed to move provider health.
 *
 * Exempt (never recorded):
 *   - client-error statuses (400/406/408/409/410/422)
 *   - content-policy / moderation refusals
 *   - local stream-lifecycle errors and local host-execution errors
 *
 * Everything else — 401/402/403/404/429/5xx/network — counts.
 */
export function shouldRecordFailure(failure = {}) {
  const { status, error, kind } = failure;

  // Callers may put the status on the wrapper or on the error itself
  // (`err.status` / `err.statusCode` are both common in this codebase).
  const carriedStatus = error != null && typeof error === "object"
    ? (typeof error.status === "number" ? error.status
      : typeof error.statusCode === "number" ? error.statusCode : undefined)
    : undefined;
  const numericStatus = Number(status ?? carriedStatus);

  if (Number.isFinite(numericStatus) && NON_TRIPPING_STATUS_SET.has(numericStatus)) return false;
  if (isPolicyRefusal(error)) return false;
  if (isLocalStreamLifecycleError(error)) return false;
  if (isLocalExecutionError(error)) return false;
  // A POLICY-tagged kind from an upstream body (not a status) is exempt too.
  if (typeof kind === "string" && /^policy$/i.test(kind)) return false;

  return true;
}

/**
 * Truncate a failure reason before it is persisted or logged, and strip
 * anything that looks like a credential so a stray token never reaches the
 * database or the log (FR-018).
 */
export function sanitizeFailureReason(reason, maxLen = 160) {
  if (reason == null) return null;
  let text = typeof reason === "string" ? reason : bodyToText(reason);
  if (!text) return null;
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*["']?[^\s"',}]{8,}/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Number(maxLen) : 160;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
