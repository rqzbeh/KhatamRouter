"use client";

import React from "react";
import {
  CAPACITY_META,
  ORDERED_MODALITIES,
  aggregateCapabilities,
  type ModalityKey,
  type ModelCapabilities,
} from "@/shared/constants/capacityMeta.ts";
import Tooltip from "./Tooltip";
import { aggregateComboCapabilities as coreAggregateComboCapabilities } from "open-sse/providers/capabilities.js";

export { aggregateCapabilities, type ModelCapabilities, type ModalityKey };

/**
 * Pure wrapper around core combo aggregation supporting nested combos,
 * provider overrides, and safe defaults for unknown models.
 */
export function aggregateComboCapabilities(
  comboModels?: string[] | null,
  comboLookup: Record<string, string[]> | null = null,
  resolveCaps: ((fullId: string) => Partial<ModelCapabilities> | null) | null = null
): ModelCapabilities | null {
  if (!comboModels || !Array.isArray(comboModels) || comboModels.length === 0) {
    return null;
  }
  return coreAggregateComboCapabilities(comboModels, comboLookup, resolveCaps);
}

export interface CapacityBadgesProps {
  caps?: Partial<ModelCapabilities> | Record<string, any> | null;
  comboModels?: string[] | null;
  comboLookup?: Record<string, string[]> | null;
  resolveCaps?: ((fullId: string) => Partial<ModelCapabilities> | null) | null;
  className?: string;
  colorOverride?: string;
  size?: number;
}

/**
 * Render small icon badges with accessible tooltips for a model or combo's capabilities.
 * Supports all 9 modalities specified in Wave 8:
 * - vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search, tools, reasoning
 */
export default function CapacityBadges({
  caps,
  comboModels,
  comboLookup = null,
  resolveCaps = null,
  className = "",
  colorOverride,
  size = 16,
}: CapacityBadgesProps) {
  let resolvedCaps: Partial<ModelCapabilities> | Record<string, any> | null = caps ?? null;

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
