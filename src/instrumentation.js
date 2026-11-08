export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    if (process.env.NEXT_PHASE !== "phase-production-build") {
      try {
        const { initializeOverrideCache } = await import("@/lib/models/overrideCache.js");
        await initializeOverrideCache();
      } catch (err) {
        console.error("[instrumentation] Failed to initialize override cache:", err);
      }
    }

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
