"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Badge from "./Badge";
import { groupPools, GROUP_LABELS } from "@/lib/network/proxyPoolGroups.js";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

// Values match COOLDOWN_PRESETS_MS in src/lib/network/proxyHealthPolicy.js.
const COOLDOWN_OPTIONS = [
  { value: "off", label: "Off (keep failing pools in rotation)" },
  { value: "60000", label: "1 minute" },
  { value: "300000", label: "5 minutes" },
  { value: "3600000", label: "1 hour" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [cooldown, setCooldown] = useState("off");
  const [cooldownError, setCooldownError] = useState("");
  const [daemonStatus, setDaemonStatus] = useState("");
  const [poolError, setPoolError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      const health = settingsData.proxyHealth || {};
      setCooldown(health.enabled ? String(health.cooldownMs) : "off");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  // Proxy health is a global setting: it applies to every provider that rotates
  // across proxy pools, since a pool's failure is recorded per provider.
  const handleCooldownChange = async (value) => {
    const previous = cooldown;
    setCooldown(value);
    setCooldownError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.proxyHealth || {};
      const next = value === "off"
        ? { ...current, enabled: false }
        : { ...current, enabled: true, cooldownMs: Number(value) };
      const saveRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyHealth: next }),
      });
      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => ({}));
        setCooldown(previous);
        setCooldownError(err.error || "Could not save the cooldown setting");
        return;
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setCooldown(previous);
      setCooldownError("Could not save the cooldown setting");
      console.log("Save proxy health error:", e);
    } finally {
      setSaving(false);
    }
  };

  const save = useCallback(async (poolId, strategy) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = async (newPoolId) => {
    setPoolError("");
    if (newPoolId === "__create_warp__" || newPoolId === "__create_psiphon__") {
      const isWarp = newPoolId === "__create_warp__";
      setDaemonStatus(isWarp ? "Starting WARP daemon…" : "Starting psiphon daemon…");
      try {
        const createBody = isWarp
          ? { name: "WARP (managed)", type: "opencode2api" }
          : { name: "psiphon", type: "psiphon" };
        const createRes = await fetch("/api/proxy-pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody),
        });
        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to create ${isWarp ? "WARP" : "psiphon"} pool`);
        }
        const created = await createRes.json();
        const createdPool = created.proxyPool || created;
        const newId = createdPool.id;
        if (!newId) throw new Error("Created pool missing id");

        let testRes = await fetch(`/api/proxy-pools/${newId}/test`, { method: "PUT" });
        if (testRes.status === 405) {
          testRes = await fetch(`/api/proxy-pools/${newId}/test`, { method: "POST" });
        }
        if (!testRes.ok) {
          const testErr = await testRes.json().catch(() => ({}));
          throw new Error(testErr.error || `Failed to test ${isWarp ? "WARP" : "psiphon"} pool`);
        }

        const poolsRes = await fetch("/api/proxy-pools", { cache: "no-store" });
        const poolsData = poolsRes.ok ? await poolsRes.json() : {};
        const freshPools = poolsData.proxyPools || [];
        setProxyPools(freshPools);
        setProxyPoolId(newId);
        await save(newId, rotateStrategy);
      } catch (err) {
        setPoolError(err.message || "Failed to configure proxy pool");
        setProxyPoolId(proxyPoolId);
      } finally {
        setDaemonStatus("");
      }
      return;
    }

    setProxyPoolId(newPoolId);
    const selected = proxyPools.find((p) => p.id === newPoolId);
    if (selected && selected.isActive === false) {
      try {
        await fetch(`/api/proxy-pools/${newPoolId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: true }),
        });
        setProxyPools((prev) =>
          prev.map((p) => (p.id === newPoolId ? { ...p, isActive: true } : p))
        );
      } catch (e) {
        console.log("Failed to activate proxy pool:", e);
      }
    }
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  const renderPoolGroups = () => {
    const grouped = groupPools(proxyPools);
    const groupsMap = new Map(grouped.map((g) => [g.key, g]));

    return Object.keys(GROUP_LABELS).map((key) => {
      const group = groupsMap.get(key);
      const pools = group ? group.pools : [];

      if (key === "psiphon") {
        return (
          <optgroup key={key} label={GROUP_LABELS[key]}>
            {pools.length > 0 ? (
              pools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}{pool.isActive === false ? " — inactive" : ""}
                </option>
              ))
            ) : (
              <option value="__create_psiphon__">Create managed psiphon pool…</option>
            )}
          </optgroup>
        );
      }

      if (key === "opencode2api") {
        return (
          <optgroup key={key} label={GROUP_LABELS[key]}>
            {pools.length > 0 ? (
              pools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}{pool.isActive === false ? " — inactive" : ""}
                </option>
              ))
            ) : (
              <option value="__create_warp__">Create managed WARP pool…</option>
            )}
          </optgroup>
        );
      }

      if (!group || pools.length === 0) return null;

      return (
        <optgroup key={key} label={group.label}>
          {pools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {pool.name}{pool.isActive === false ? " — inactive" : ""}
            </option>
          ))}
        </optgroup>
      );
    });
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-main">
          {daemonStatus || "Proxy Pool"}
        </label>
        <div className="relative">
          <select
            value={proxyPoolId}
            onChange={(e) => handlePoolChange(e.target.value)}
            disabled={saving || isRotation || !!daemonStatus}
            className="w-full py-2.5 px-3 pr-10 text-sm text-text-main bg-surface-2 border border-transparent rounded-[10px] appearance-none focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed text-[16px] sm:text-sm"
          >
            <option value={NONE_PROXY_POOL_VALUE}>None (direct)</option>
            {renderPoolGroups()}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-text-muted">
            <span className="material-symbols-outlined text-[20px]">expand_more</span>
          </div>
        </div>
        {poolError && <p className="text-xs text-red-500">{poolError}</p>}
        {isRotation && (
          <p className="text-xs text-text-muted">
            Pool selector is ignored when rotation is active — all active pools are used.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>

      {isRotation && (
        <div className="flex flex-col gap-2 mt-4">
          <label htmlFor="proxy-cooldown" className="text-sm font-medium text-text-main">Remove failing pool for</label>
          <select
            id="proxy-cooldown"
            value={cooldown}
            onChange={(e) => handleCooldownChange(e.target.value)}
            disabled={saving}
            className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
          >
            {COOLDOWN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted">
            When a request through a pool hits a rate limit (429), a region or egress block (451, or
            403 with explicit egress attribution) or a proxy failure (502-504, connection errors),
            that pool is skipped for this long and then rejoins the rotation automatically. A longer
            upstream Retry-After is respected. Applies to all providers that rotate pools. If every
            pool is cooling, rotation uses them anyway rather than going direct.
          </p>
          {cooldownError && <p className="text-xs text-red-500">{cooldownError}</p>}
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
