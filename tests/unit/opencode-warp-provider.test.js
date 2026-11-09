// tests/unit/opencode-warp-provider.test.js
//
// The WARP lane (provider `opencode-warp`, alias `ocw`) must always leave over
// the bundled sidecar. Two halves are pinned here: the provider is registered
// with its virtual pool id, and the resolver synthesizes that pool when no row
// exists — a fall-through to `source:"none"` would silently egress over the
// server's own IP, which is exactly what the free tier rejects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

const ensureSidecar = vi.fn();

vi.mock("@/lib/network/opencode2api/sidecarManager.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureSidecar: (...args) => ensureSidecar(...args),
  };
});

describe("opencode-warp provider", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-warp-test-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    ensureSidecar.mockReset();
    ensureSidecar.mockResolvedValue({
      proxyUrl: "http://127.0.0.1:41000",
      apiKey: "local-key",
      generation: 3,
    });
  });

  afterEach(() => {
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
    delete global._dbAdapter;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("registers the provider with its managed pool id and alias", async () => {
    const { FREE_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    const entry = FREE_PROVIDERS["opencode-warp"];
    expect(entry).toBeTruthy();
    expect(entry.noAuth).toBe(true);
    expect(entry.managedSidecarPoolId).toBe("opencode-warp-managed");
    expect(entry.alias).toBe("ocw");
  });

  it("synthesizes the managed pool when no row exists", async () => {
    const { resolveConnectionProxyConfig } = await import(
      "../../src/lib/network/connectionProxy.js"
    );
    const resolved = await resolveConnectionProxyConfig({
      proxyPoolId: "opencode-warp-managed",
    });

    expect(resolved.source).toBe("opencode2api");
    expect(resolved.strictProxy).toBe(true);
    expect(resolved.opencodeSidecarUrl).toBe("http://127.0.0.1:41000");
    expect(resolved.opencodeSidecarKey).toBe("local-key");
    expect(ensureSidecar).toHaveBeenCalledTimes(1);
  });

  it("prefers a real pool row of another type when one exists", async () => {
    const repo = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
    await repo.createProxyPool({
      name: "manual",
      proxyUrl: "http://10.9.9.9:3128",
      type: "http",
      isActive: true,
    });
    const created = (await repo.getProxyPools())[0];

    const { resolveConnectionProxyConfig } = await import(
      "../../src/lib/network/connectionProxy.js"
    );
    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: created.id });

    expect(resolved.source).not.toBe("opencode2api");
    expect(ensureSidecar).not.toHaveBeenCalled();
  });

  it("registers a distinct executor for the lane", async () => {
    const { getExecutor, hasSpecializedExecutor } = await import(
      "../../open-sse/executors/index.js"
    );
    expect(hasSpecializedExecutor("opencode-warp")).toBe(true);
    const warp = getExecutor("opencode-warp");
    expect(warp).toBeTruthy();
    expect(warp).not.toBe(getExecutor("opencode"));
  });
});