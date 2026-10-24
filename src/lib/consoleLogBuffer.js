import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";
import {
  getRedisClient,
  getRedisSubscriber,
  isRedisConfigured,
} from "@/lib/redis/client.js";

export const CONSOLE_LOG_CHANNEL = "khatam:events:console_log";

let logInstanceId = `log-inst-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export function getLogInstanceId() {
  return logInstanceId;
}

export function setLogInstanceId(newId) {
  logInstanceId = newId;
}

const consoleLevels = ["log", "info", "warn", "error", "debug"];

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

if (!state.pendingLines) state.pendingLines = [];
if (!state.flushTimer) state.flushTimer = null;

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

let isSubscribedToRedis = false;
let redisMessageListener = null;

function parseLogEnvelope(raw) {
  if (typeof raw !== "string") return { source: null, payload: raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "source" in parsed) {
      return { source: parsed.source, payload: parsed.payload ?? null };
    }
    return { source: null, payload: parsed };
  } catch {
    return { source: null, payload: raw };
  }
}

export function initConsoleLogFanout() {
  if (!isRedisConfigured() || isSubscribedToRedis) return;

  const sub = getRedisSubscriber();
  if (!sub) return;

  redisMessageListener = (channel, raw) => {
    if (channel !== CONSOLE_LOG_CHANNEL) return;

    const envelope = parseLogEnvelope(raw);

    // INVARIANT: Zero double-echo on origin instance
    if (envelope.source === logInstanceId) return;

    const payload = envelope.payload;
    const remoteLines = Array.isArray(payload?.lines)
      ? payload.lines
      : (Array.isArray(payload) ? payload : (typeof payload?.line === "string" ? [payload.line] : []));

    if (remoteLines.length) {
      appendRemoteLines(remoteLines);
    }
  };

  sub.on("message", redisMessageListener);

  const subscribeIfReady = () => {
    sub.subscribe(CONSOLE_LOG_CHANNEL).catch(() => {});
  };

  if (sub.status === "ready") {
    subscribeIfReady();
  } else {
    sub.once("ready", subscribeIfReady);
  }

  isSubscribedToRedis = true;
}

export function closeConsoleLogFanout() {
  if (isSubscribedToRedis) {
    const sub = getRedisSubscriber();
    if (sub && redisMessageListener) {
      try {
        sub.off("message", redisMessageListener);
        if (sub.status === "ready") {
          sub.unsubscribe(CONSOLE_LOG_CHANNEL).catch(() => {});
        }
      } catch {}
    }
    redisMessageListener = null;
    isSubscribedToRedis = false;
  }
}

export async function fanoutConsoleLines(lines) {
  if (!Array.isArray(lines) || !lines.length || !isRedisConfigured()) return;
  if (process.env.REDIS_LOG_FANOUT_DISABLED === "true") return;

  try {
    const client = getRedisClient();
    if (!client) return;

    const envelope = {
      source: logInstanceId,
      channel: CONSOLE_LOG_CHANNEL,
      timestamp: Date.now(),
      payload: { lines },
    };

    const pub = client.publish(CONSOLE_LOG_CHANNEL, JSON.stringify(envelope));
    if (pub && typeof pub.catch === "function") {
      pub.catch(() => {});
    }
  } catch {
    // Fail-open
  }
}

function appendRemoteLines(lines) {
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  state.logs.push(...lines);
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  // Emit to local dashboard stream viewers without queuing for republish
  state.emitter.emit("lines", lines);
}

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;

  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
  fanoutConsoleLines(lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function appendLine(line) {
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function initConsoleLogCapture() {
  initConsoleLogFanout();

  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      appendLine(toLogLine(level, args));
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
