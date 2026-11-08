import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import {
  getCustomModels,
  addCustomModel,
  deleteCustomModel,
} from "@/models";
import {
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import {
  listImportedModels,
  batchUpsertImportedModels,
  pruneImportedSnapshot,
  listCapabilityOverrides,
} from "../db/repos/modelMetadataRepo.js";
import { importProviderModels } from "./importOrchestrator.js";
import {
  createProviderSyncScheduler,
  getSyncPolicy,
} from "./providerSync.js";

/**
 * Resolves the storage alias for custom models, matching provider page conventions.
 */
export function storageAliasFor(providerId) {
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)
    ? providerId
    : getProviderAlias(providerId);
}

const sharedRepo = {
  listImportedModels,
  batchUpsertImportedModels,
  pruneImportedSnapshot,
  listCapabilityOverrides,
  getCustomModels,
  addCustomModel,
  deleteCustomModel,
};

/**
 * Shared runtime adapter to import models for a single connection.
 * Calls resolveProviderModels(null, id) without fake headers — trusted background context.
 */
export async function importConnectionModels(connection, { signal } = {}) {
  const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");

  return await importProviderModels({
    provider: connection.provider,
    providerAlias: storageAliasFor(connection.provider),
    connectionId: connection.id,
    signal,
    discover: async () => {
      const { body, status } = await resolveProviderModels(null, connection.id, { signal });
      if (status >= 400) return { error: body?.error || "Discovery failed", status };
      return body;
    },
    repo: sharedRepo,
  });
}

/**
 * Singleton scheduler factory and lifecycle manager.
 * Stores singleton instance on globalThis.__modelSyncScheduler to survive HMR/reloads.
 */
export function getModelSyncScheduler() {
  if (!globalThis.__modelSyncScheduler) {
    globalThis.__modelSyncScheduler = createProviderSyncScheduler({
      getPolicy: getSyncPolicy,
      listConnections: () => getProviderConnections({ isActive: 1 }),
      importConnection: (conn, opts) => importConnectionModels(conn, opts),
    });
  }
  return globalThis.__modelSyncScheduler;
}

export function startModelSyncScheduler() {
  const scheduler = getModelSyncScheduler();
  return scheduler.start();
}

export function stopModelSyncScheduler() {
  if (globalThis.__modelSyncScheduler) {
    globalThis.__modelSyncScheduler.stop();
  }
}
