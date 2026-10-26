"use client";

import React from "react";
import {
  CAPACITY_META,
  ORDERED_MODALITIES,
  aggregateCapabilities,
} from "@/shared/constants/capacityMeta";
import Tooltip from "./Tooltip";
import { aggregateComboCapabilities as coreAggregateComboCapabilities } from "open-sse/providers/capabilities.js";

export { aggregateCapabilities };

/**
 * Pure wrapper around core combo aggregation supporting nested combos,
 * provider overrides, and safe defaults for unknown models.
 *
 * @param {string[] | null} [comboModels]
 * @param {Record<string, string[]> | null} [comboLookup]
 * @param {((fullId: string) => any) | null} [resolveCaps]
 * @returns {any}
 */
export function aggregateComboCapabilities(
  comboModels,
  comboLookup = null,
  resolveCaps = null
) {
  if (!comboModels || !Array.isArray(comboModels) || comboModels.length === 0) {
    return null;
  }
  return coreAggregateComboCapabilities(comboModels, comboLookup, resolveCaps);
}

/**
 * Render small icon badges with accessible tooltips for a model or combo's capabilities.
 * Supports all 9 modalities specified in Wave 8:
 * - vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search, tools, reasoning
 * Also maintains full backward compatibility with legacy callers passing caps, className, colorOverride, size.
 *
 * @param {Object} props
 * @param {Record<string, any> | null} [props.caps]
 * @param {string[] | null} [props.comboModels]
 * @param {Record<string, string[]> | null} [props.comboLookup]
 * @param {((fullId: string) => any) | null} [props.resolveCaps]
 * @param {string} [props.className]
 * @param {string} [props.colorOverride]
 * @param {number} [props.size]
 */
export default function CapacityBadges({
  caps,
  comboModels,
  comboLookup = null,
  resolveCaps = null,
  className = "",
  colorOverride,
  size = 16,
}) {
  let resolvedCaps = caps ?? null;

  if (!resolvedCaps && comboModels && Array.isArray(comboModels) && comboModels.length > 0) {
    resolvedCaps = aggregateComboCapabilities(comboModels, comboLookup, resolveCaps);
  }

  if (!resolvedCaps || typeof resolvedCaps !== "object") return null;

  const active = ORDERED_MODALITIES.filter((k) => Boolean(resolvedCaps?.[k]));
  if (active.length === 0) return null;

  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {active.map((k) => {
        const meta = CAPACITY_META[k];
        if (!meta) return null;
        const tooltipText = `${meta.label} — ${meta.desc}`;
        return (
          <Tooltip key={k} text={tooltipText} color={undefined}>
            <span
              className={`material-symbols-outlined leading-none cursor-help ${colorOverride || meta.color}`}
              style={{ fontSize: `${size}px` }}
              title={tooltipText}
              aria-label={tooltipText}
              role="img"
            >
              {meta.icon}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}
