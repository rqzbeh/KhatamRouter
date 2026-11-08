// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  getDisabledModels, getDisabledByProvider, getDisabledModelAudit, disableModels, disableModelsWithAudit, enableModels,
} from "@/lib/db/index.js";
