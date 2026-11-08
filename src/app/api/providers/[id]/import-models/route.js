import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
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
} from "@/lib/db/repos/modelMetadataRepo.js";
import { importProviderModels } from "@/lib/models/importOrchestrator.js";
import { resolveProviderModels } from "../models/route.js";

export const dynamic = "force-dynamic";

// Same rule the provider page uses, so imported rows land where it reads them.
function storageAliasFor(providerId) {
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)
    ? providerId
    : getProviderAlias(providerId);
}

// POST /api/providers/[id]/import-models  ?dryRun=1 to preview without writing.
// Fetches the connection's live model list and reconciles the catalog: adds new
// models, updates capabilities, and removes previously imported models the
// provider stopped listing (only when the listing is live and complete).
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

    const result = await importProviderModels({
      provider: connection.provider,
      providerAlias: storageAliasFor(connection.provider),
      connectionId: connection.id,
      dryRun,
      discover: async () => {
        const { body, status } = await resolveProviderModels(request, id);
        if (status >= 400) return { error: body?.error || "Discovery failed", status };
        return body;
      },
      repo: {
        listImportedModels,
        batchUpsertImportedModels,
        pruneImportedSnapshot,
        listCapabilityOverrides,
        getCustomModels,
        addCustomModel,
        deleteCustomModel,
      },
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status || 502 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error importing provider models:", error?.message || error);
    return NextResponse.json({ error: "Failed to import models" }, { status: 500 });
  }
}
