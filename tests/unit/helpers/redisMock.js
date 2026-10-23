/**
 * Enhanced in-memory FakeRedis mock for KhatamRouter unit and cluster-simulation tests.
 *
 * Implements:
 * - String operations: get, set (with EX, NX, XX), del, incr, decr, incrby, incrbyfloat, expire, ttl
 * - Sorted Set (ZSET) operations: zadd, zrem, zcard, zremrangebyscore, zrangebyscore, zscore
 * - Script execution: eval (emulating KhatamRouter Lua scripts: semaphore acquire/release, quota consume)
 * - Pub/Sub: subscribe, unsubscribe, publish, on("message", handler)
 * - Strict RESP2 / RESP3 subscriber-mode rejection: once in subscriber mode, any command
 *   other than subscriber commands throws an Error ("Connection in subscriber mode, only subscriber commands may be used").
 */

import { EventEmitter } from "node:events";

const SUBSCRIBER_COMMANDS = new Set([
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "ping",
  "quit",
  "disconnect",
  "removeAllListeners",
  "on",
  "once",
  "off",
  "emit",
  "addListener",
  "removeListener",
]);

class SharedClusterState {
  constructor() {
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(500);
    this.store = new Map();
    this.zsets = new Map();
    this.expires = new Map();
    this.subscribers = new Map(); // channel -> Set<FakeRedis>
  }

  clear() {
    this.store.clear();
    this.zsets.clear();
    this.expires.clear();
    this.subscribers.clear();
    this.bus.removeAllListeners();
  }

  isExpired(key) {
    const exp = this.expires.get(key);
    if (exp !== undefined && Date.now() > exp) {
      this.store.delete(key);
      this.zsets.delete(key);
      this.expires.delete(key);
      return true;
    }
    return false;
  }
}

const defaultCluster = new SharedClusterState();

export class FakeRedis extends EventEmitter {
  constructor(options = {}) {
    super();
    this.status = options.status || "ready";
    this.cluster = options.cluster || defaultCluster;
    this.failOn = new Set(options.failOn || []);
    this.inSubscriberMode = Boolean(options.subscriber);
    this.subscriptions = new Set();
  }

  static clearAll() {
    defaultCluster.clear();
  }

  _checkSubscriber(commandName) {
    if (this.inSubscriberMode && !SUBSCRIBER_COMMANDS.has(commandName)) {
      throw new Error("Connection in subscriber mode, only subscriber commands may be used");
    }
    if (this.failOn.has(commandName)) {
      throw new Error(`Simulated Redis command failure: ${commandName}`);
    }
  }

  async connect() {
    this.status = "ready";
    this.emit("ready");
    return this;
  }

  async quit() {
    this.status = "end";
    for (const channel of this.subscriptions) {
      const subs = this.cluster.subscribers.get(channel);
      if (subs) subs.delete(this);
    }
    this.subscriptions.clear();
    this.removeAllListeners();
    return "OK";
  }

  disconnect() {
    this.status = "end";
    for (const channel of this.subscriptions) {
      const subs = this.cluster.subscribers.get(channel);
      if (subs) subs.delete(this);
    }
    this.subscriptions.clear();
  }

  // --- Pub/Sub ---

  async subscribe(...channels) {
    this._checkSubscriber("subscribe");
    this.inSubscriberMode = true;
    for (const channel of channels) {
      this.subscriptions.add(channel);
      let subs = this.cluster.subscribers.get(channel);
      if (!subs) {
        subs = new Set();
        this.cluster.subscribers.set(channel, subs);
      }
      subs.add(this);
    }
    return channels.length;
  }

  async unsubscribe(...channels) {
    const toRemove = channels.length > 0 ? channels : Array.from(this.subscriptions);
    for (const channel of toRemove) {
      this.subscriptions.delete(channel);
      const subs = this.cluster.subscribers.get(channel);
      if (subs) {
        subs.delete(this);
        if (subs.size === 0) this.cluster.subscribers.delete(channel);
      }
    }
    return toRemove.length;
  }

  async publish(channel, message) {
    this._checkSubscriber("publish");
    const subs = this.cluster.subscribers.get(channel);
    let count = 0;
    if (subs) {
      for (const sub of subs) {
        count++;
        // Emit message event asynchronously to mimic network socket
        queueMicrotask(() => {
          sub.emit("message", channel, String(message));
        });
      }
    }
    return count;
  }

  // --- Strings ---

  async get(key) {
    this._checkSubscriber("get");
    if (this.cluster.isExpired(key)) return null;
    return this.cluster.store.has(key) ? String(this.cluster.store.get(key)) : null;
  }

  async set(key, val, ...args) {
    this._checkSubscriber("set");
    let exSeconds = null;
    let nx = false;
    let xx = false;

    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]).toUpperCase();
      if (arg === "EX" && i + 1 < args.length) {
        exSeconds = Number(args[++i]);
      } else if (arg === "NX") {
        nx = true;
      } else if (arg === "XX") {
        xx = true;
      }
    }

    const exists = this.cluster.store.has(key) && !this.cluster.isExpired(key);

    if (nx && exists) return null;
    if (xx && !exists) return null;

    this.cluster.store.set(key, String(val));
    if (exSeconds !== null && Number.isFinite(exSeconds)) {
      this.cluster.expires.set(key, Date.now() + exSeconds * 1000);
    } else {
      this.cluster.expires.delete(key);
    }
    return "OK";
  }

  async del(...keys) {
    this._checkSubscriber("del");
    let count = 0;
    for (const key of keys) {
      let existed = false;
      if (this.cluster.store.delete(key)) existed = true;
      if (this.cluster.zsets.delete(key)) existed = true;
      this.cluster.expires.delete(key);
      if (existed) count++;
    }
    return count;
  }

  async incr(key) {
    return this.incrby(key, 1);
  }

  async decr(key) {
    return this.incrby(key, -1);
  }

  async incrby(key, amount) {
    this._checkSubscriber("incrby");
    if (this.cluster.isExpired(key)) this.cluster.store.delete(key);
    const curr = parseInt(this.cluster.store.get(key) || "0", 10);
    const next = curr + Number(amount);
    this.cluster.store.set(key, String(next));
    return next;
  }

  async incrbyfloat(key, amount) {
    this._checkSubscriber("incrbyfloat");
    if (this.cluster.isExpired(key)) this.cluster.store.delete(key);
    const curr = parseFloat(this.cluster.store.get(key) || "0");
    const next = curr + parseFloat(amount);
    const str = String(next);
    this.cluster.store.set(key, str);
    return str;
  }

  async expire(key, seconds) {
    this._checkSubscriber("expire");
    const exists = (this.cluster.store.has(key) || this.cluster.zsets.has(key)) && !this.cluster.isExpired(key);
    if (!exists) return 0;
    this.cluster.expires.set(key, Date.now() + Number(seconds) * 1000);
    return 1;
  }

  async ttl(key) {
    this._checkSubscriber("ttl");
    const exists = (this.cluster.store.has(key) || this.cluster.zsets.has(key));
    if (!exists) return -2;
    if (this.cluster.isExpired(key)) return -2;
    const exp = this.cluster.expires.get(key);
    if (exp === undefined) return -1;
    return Math.max(0, Math.ceil((exp - Date.now()) / 1000));
  }

  // --- Sorted Sets (ZSET) ---

  _getOrCreateZSet(key) {
    if (this.cluster.isExpired(key)) this.cluster.zsets.delete(key);
    let zset = this.cluster.zsets.get(key);
    if (!zset) {
      zset = new Map(); // member -> number(score)
      this.cluster.zsets.set(key, zset);
    }
    return zset;
  }

  async zadd(key, ...args) {
    this._checkSubscriber("zadd");
    const zset = this._getOrCreateZSet(key);
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      if (!zset.has(member)) added++;
      zset.set(member, score);
    }
    return added;
  }

  async zrem(key, ...members) {
    this._checkSubscriber("zrem");
    if (this.cluster.isExpired(key)) return 0;
    const zset = this.cluster.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const member of members) {
      if (zset.delete(String(member))) removed++;
    }
    return removed;
  }

  async zcard(key) {
    this._checkSubscriber("zcard");
    if (this.cluster.isExpired(key)) return 0;
    const zset = this.cluster.zsets.get(key);
    return zset ? zset.size : 0;
  }

  async zscore(key, member) {
    this._checkSubscriber("zscore");
    if (this.cluster.isExpired(key)) return null;
    const zset = this.cluster.zsets.get(key);
    if (!zset || !zset.has(String(member))) return null;
    return String(zset.get(String(member)));
  }

  async zremrangebyscore(key, min, max) {
    this._checkSubscriber("zremrangebyscore");
    if (this.cluster.isExpired(key)) return 0;
    const zset = this.cluster.zsets.get(key);
    if (!zset) return 0;

    const minNum = min === "-inf" || min === "-Infinity" ? -Infinity : Number(min);
    const maxNum = max === "+inf" || max === "+Infinity" ? Infinity : Number(max);

    let removed = 0;
    for (const [member, score] of Array.from(zset.entries())) {
      if (score >= minNum && score <= maxNum) {
        zset.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zrangebyscore(key, min, max) {
    this._checkSubscriber("zrangebyscore");
    if (this.cluster.isExpired(key)) return [];
    const zset = this.cluster.zsets.get(key);
    if (!zset) return [];

    const minNum = min === "-inf" || min === "-Infinity" ? -Infinity : Number(min);
    const maxNum = max === "+inf" || max === "+Infinity" ? Infinity : Number(max);

    const matches = [];
    for (const [member, score] of zset.entries()) {
      if (score >= minNum && score <= maxNum) {
        matches.push({ member, score });
      }
    }
    matches.sort((a, b) => a.score - b.score);
    return matches.map((m) => m.member);
  }

  // --- Script Execution (eval) ---

  async eval(script, numkeys, ...args) {
    this._checkSubscriber("eval");
    const scriptStr = String(script);
    const nKeys = Number(numkeys) || 0;
    const keys = args.slice(0, nKeys);
    const argv = args.slice(nKeys);

    // Semaphore TRY_ACQUIRE emulation
    if (scriptStr.includes("ZREMRANGEBYSCORE") && scriptStr.includes("ZCARD")) {
      const key = keys[0];
      const now = Number(argv[0]);
      const leaseExpiresAt = Number(argv[1]);
      const maxConcurrent = Number(argv[2]);
      const leaseId = String(argv[3]);
      const ttlSec = Number(argv[4]);

      await this.zremrangebyscore(key, "-inf", now);
      const count = await this.zcard(key);

      if (count < maxConcurrent) {
        await this.zadd(key, leaseExpiresAt, leaseId);
        await this.expire(key, ttlSec);
        return [1, count + 1];
      } else {
        return [0, count];
      }
    }

    // Semaphore RELEASE emulation
    if (scriptStr.includes("ZREM") && scriptStr.includes("KEYS[1]")) {
      const key = keys[0];
      const leaseId = String(argv[0]);
      await this.zrem(key, leaseId);
      return 1;
    }

    // Quota CONSUME_LUA emulation
    if (scriptStr.includes("INCRBYFLOAT") && scriptStr.includes("weightPrev")) {
      const currKey = keys[0];
      const prevKey = keys[1];
      const amount = Number(argv[0]);
      const limit = Number(argv[1]);
      const weightPrev = Number(argv[2]);
      const ttlSec = Number(argv[3]);

      const currRaw = await this.get(currKey);
      const prevRaw = await this.get(prevKey);
      const curr = parseFloat(currRaw || "0") || 0;
      const prev = parseFloat(prevRaw || "0") || 0;
      const existing = (prev * weightPrev) + curr;
      const newUsage = existing + amount;

      if (newUsage <= limit) {
        const newCurr = await this.incrbyfloat(currKey, amount);
        await this.expire(currKey, ttlSec);
        return [1, String(newCurr), String(prev), String(newUsage)];
      } else {
        return [0, String(curr), String(prev), String(existing)];
      }
    }

    throw new Error(`Unsupported script in FakeRedis: ${scriptStr.slice(0, 80)}`);
  }
}

export default FakeRedis;
