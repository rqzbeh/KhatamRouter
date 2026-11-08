import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping.js";
import { disableModelsWithAudit, getDisabledModelAuditByProvider } from "@/lib/db/repos/disabledModelsRepo.js";
import { runModelTestBatch } from "@/lib/models/modelTestBatch.js";

export const dynamic = "force-dynamic";

const LEASE_SCOPE = "modelTestBatchLease";
const BATCH_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const LEASE_DURATION_MS = BATCH_DURATION_MS + 30 * 1000; // 5 min + 30s margin for cleanup/persist
const MAX_GLOBAL_CONCURRENT_BATCHES = 2;

// In-process lease tracking to enforce local limits and fast-fail concurrent runs
const inProcessLeases = new Map();

/**
 * Normalizes model ID: strips redundant provider/alias prefix if explicitly supplied,
 * while preserving vendor namespaces like "anthropic/claude-3-5-sonnet" on openrouter.
 */
function toCanonicalModelId(modelId, providerId, providerAlias) {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  const idPrefix = `${providerId.toLowerCase()}/`;
  const aliasPrefix = providerAlias ? `${providerAlias.toLowerCase()}/` : "";

  if (aliasPrefix && lower.startsWith(aliasPrefix)) {
    return trimmed.slice(aliasPrefix.length);
  }
  if (lower.startsWith(idPrefix)) {
    return trimmed.slice(idPrefix.length);
  }
  return trimmed;
}

/**
 * Validates request payload upfront before taking any lease or database lock.
 * Returns null if valid, or a string error message if invalid.
 */
function prevalidateBatchRequest(body) {
  if (!body || typeof body !== "object") {
    return "Invalid JSON request body";
  }

  const { providerId, connectionId, modelIds, autoDisable, respectRateLimit } = body;

  if (typeof providerId !== "string" || !providerId.trim()) {
    return "providerId string required";
  }
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    return "connectionId string required";
  }
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return "modelIds non-empty array required";
  }
  if (modelIds.length > 100) {
    return "modelIds exceeds maximum cap of 100 models";
  }
  if (autoDisable !== undefined && typeof autoDisable !== "boolean") {
    return "autoDisable must be a boolean";
  }
  if (respectRateLimit !== undefined && typeof respectRateLimit !== "boolean") {
    return "respectRateLimit must be a boolean";
  }

  const seen = new Set();
  for (let i = 0; i < modelIds.length; i++) {
    const raw = modelIds[i];
    if (typeof raw !== "string") {
      return `modelId at index ${i} must be a string`;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return `modelId at index ${i} must not be empty`;
    }
    if (trimmed.length > 256) {
      return `modelId at index ${i} exceeds maximum length of 256 characters`;
    }
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
      return `modelId at index ${i} contains forbidden control characters`;
    }
    if (seen.has(trimmed)) {
      return `duplicate modelId detected: ${trimmed}`;
    }
    seen.add(trimmed);
  }

  return null;
}

/**
 * Checks if a provider ID is known to the router.
 */
async function isKnownProvider(providerId, db) {
  if (PROVIDER_ID_TO_ALIAS[providerId]) return true;
  for (const alias of Object.values(PROVIDER_ID_TO_ALIAS)) {
    if (alias === providerId) return true;
  }
  const conn = db.get("SELECT 1 FROM providerConnections WHERE provider = ? LIMIT 1", [providerId]);
  if (conn) return true;
  const node = db.get("SELECT 1 FROM providerNodes WHERE type = ? LIMIT 1", [providerId]);
  if (node) return true;
  return false;
}

export async function POST(request) {
  let batchToken = null;
  let leasedAlias = null;

  try {
    const body = await request.json().catch(() => null);

    // 1. Strict typed pre-validation before acquiring any lease
    const validationError = prevalidateBatchRequest(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { providerId, connectionId, modelIds, autoDisable = false, respectRateLimit = true } = body;

    // 2. Verify connection exists, matches provider, and is active
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (connection.provider !== providerId) {
      return NextResponse.json({ error: "Connection does not match specified providerId" }, { status: 400 });
    }
    if (connection.isActive === false) {
      return NextResponse.json({ error: "Selected connection is inactive" }, { status: 400 });
    }

    const providerAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    // 3. Normalize model IDs to canonical raw IDs
    const canonicalModelIds = modelIds.map((id) => toCanonicalModelId(id, providerId, providerAlias));

    // 4. In-process fast-fail check
    const now = Date.now();
    const existingInProc = inProcessLeases.get(providerAlias);
    if (existingInProc && existingInProc.expiresAt > now) {
      return NextResponse.json({ error: "A test batch is already running for this provider" }, { status: 409 });
    }
    if (inProcessLeases.size >= MAX_GLOBAL_CONCURRENT_BATCHES) {
      let activeCount = 0;
      for (const lease of inProcessLeases.values()) {
        if (lease.expiresAt > now) activeCount++;
      }
      if (activeCount >= MAX_GLOBAL_CONCURRENT_BATCHES) {
        return NextResponse.json(
          { error: `Server maximum concurrent test batches (${MAX_GLOBAL_CONCURRENT_BATCHES}) reached` },
          { status: 429 }
        );
      }
    }

    // 5. Cross-worker SQLite lease acquisition with global max 2 ceiling inside immediate tx
    batchToken = crypto.randomUUID();
    const db = await getAdapter();
    const leaseExpiry = now + LEASE_DURATION_MS;
    let leaseRejectionStatus = null;
    let leaseRejectionError = null;

    db.immediate(() => {
      // Evict expired leases
      const allRows = db.all("SELECT key, value FROM kv WHERE scope = ?", [LEASE_SCOPE]);
      let activeLeaseCount = 0;
      for (const row of allRows) {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed?.expiresAt && parsed.expiresAt <= now) {
            db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [LEASE_SCOPE, row.key]);
          } else {
            activeLeaseCount++;
          }
        } catch {
          db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [LEASE_SCOPE, row.key]);
        }
      }

      // Check cross-worker global cap of 2 concurrent batches
      if (activeLeaseCount >= MAX_GLOBAL_CONCURRENT_BATCHES) {
        leaseRejectionStatus = 429;
        leaseRejectionError = `Server maximum concurrent test batches (${MAX_GLOBAL_CONCURRENT_BATCHES}) reached`;
        return;
      }

      // Check per-provider cross-worker lease
      const providerRow = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [LEASE_SCOPE, providerAlias]);
      if (providerRow) {
        try {
          const parsed = JSON.parse(providerRow.value);
          if (parsed?.expiresAt && parsed.expiresAt > now) {
            leaseRejectionStatus = 409;
            leaseRejectionError = "A test batch is already running for this provider";
            return;
          }
        } catch {}
      }

      // Acquire lease
      db.run(
        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        [LEASE_SCOPE, providerAlias, JSON.stringify({ token: batchToken, expiresAt: leaseExpiry })]
      );
    });

    if (leaseRejectionStatus) {
      return NextResponse.json({ error: leaseRejectionError }, { status: leaseRejectionStatus });
    }

    leasedAlias = providerAlias;
    inProcessLeases.set(providerAlias, { token: batchToken, expiresAt: leaseExpiry });

    // 6. Setup probe and disable callbacks
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    const probe = async (canonicalId, { signal }) => {
      const qualifiedModel = `${providerAlias}/${canonicalId}`;
      return pingModelByKind(qualifiedModel, "llm", baseUrl, { signal });
    };

    const disableModel = async ({ id, reason, disabledAt, batchId }) => {
      await disableModelsWithAudit(providerAlias, [id], { reason, disabledAt, batchId });
    };

    // 7. Execute bounded batch with request.signal passed down
    const batchResult = await runModelTestBatch({
      modelIds: canonicalModelIds,
      probe,
      autoDisable: autoDisable === true,
      disableModel,
      signal: request.signal,
      maxBatchDurationMs: BATCH_DURATION_MS,
      intervalMs: respectRateLimit !== false ? 1000 : 0,
      rateLimitThreshold: 3,
      botBlockThreshold: 2,
    });

    return NextResponse.json({
      batchId: batchResult.batchId,
      providerId,
      providerAlias,
      connectionId,
      executionScope: "provider",
      executionNote:
        "Probes execute through KhatamRouter's provider routing aggregate across active connections. connectionId provides authorization and catalog scope.",
      summary: batchResult.summary,
      results: batchResult.results,
      stoppedEarly: batchResult.stoppedEarly,
      stopReason: batchResult.stopReason,
    });
  } catch {
    return NextResponse.json({ error: "Batch test execution failed" }, { status: 500 });
  } finally {
    if (leasedAlias && batchToken) {
      if (inProcessLeases.get(leasedAlias)?.token === batchToken) {
        inProcessLeases.delete(leasedAlias);
      }
      try {
        const db = await getAdapter();
        db.immediate(() => {
          const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [LEASE_SCOPE, leasedAlias]);
          if (row) {
            try {
              const parsed = JSON.parse(row.value);
              if (parsed?.token === batchToken) {
                db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [LEASE_SCOPE, leasedAlias]);
              }
            } catch {}
          }
        });
      } catch {}
    }
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerId = searchParams.get("providerId");
    if (!providerId || typeof providerId !== "string" || !providerId.trim()) {
      return NextResponse.json({ error: "providerId query parameter required" }, { status: 400 });
    }

    const trimmedProviderId = providerId.trim();
    const db = await getAdapter();
    const known = await isKnownProvider(trimmedProviderId, db);
    if (!known) {
      return NextResponse.json({ error: `Unknown provider: ${trimmedProviderId}` }, { status: 400 });
    }

    const providerAlias = PROVIDER_ID_TO_ALIAS[trimmedProviderId] || trimmedProviderId;
    const audit = await getDisabledModelAuditByProvider(providerAlias);

    return NextResponse.json({
      providerId: trimmedProviderId,
      providerAlias,
      audit,
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch disabled model audit" }, { status: 500 });
  }
}
