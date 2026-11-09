export {
  MANAGED_SIDECAR_URL,
  OpencodeSidecarUnavailableError,
  DEFAULT_SIDECAR_CONFIG,
  SIDECAR_LIMITS,
  validateSidecarConfig,
  normalizeSidecarConfig,
  getSidecarBinPath,
  allocatePort,
  createSidecarConfigFile,
  cleanSidecarConfigFile,
  getSidecarRunDir,
  sweepStaleSidecarDirs,
} from "./config.js";

export {
  isOpencodeSidecarPool,
  ensureSidecar,
  stopSidecar,
  getStatus,
  checkHealth,
  terminateProcess,
  sidecarSpawnCount,
  __resetForTests,
  __resetSidecarSpawnCount,
  __setSpawnForTests,
  __setHealthFetchForTests,
  __getActiveChildForTests,
} from "./sidecarManager.js";
