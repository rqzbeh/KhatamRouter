import { describe, expect, it, vi } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import * as providersModule from "../../open-sse/services/tokenRefresh/providers.js";

// CodeBuddy access tokens live ~1 year, so shouldRefreshCredentials never fires
// for them: the pre-flight expiry check cannot rescue a connection whose token
// was revoked or rejected. The executor-level 401/403 retry in chatCore is the
// only recovery path, and it is a no-op unless refreshCredentials is wired.
// Regression guard for that wiring (issue #161).
describe("CodeBuddy executor refresh wiring", () => {
  for (const provider of ["codebuddy-cn", "codebuddy-intl"]) {
    it(`${provider} exposes a refresh path instead of the base no-op`, async () => {
      const executor = new DefaultExecutor(provider);
      // BaseExecutor.refreshCredentials returns null unconditionally; the wired
      // implementation returns null too when there is no refresh token, so the
      // distinguishing assertion is that the subclass method is not the base one.
      const base = Object.getPrototypeOf(DefaultExecutor.prototype).refreshCredentials;
      expect(executor.refreshCredentials).not.toBe(base);
    });

    it(`${provider} returns null without a refresh token (manual paste must not throw)`, async () => {
      const executor = new DefaultExecutor(provider);
      await expect(executor.refreshCredentials({}, null)).resolves.toBeNull();
      await expect(executor.refreshCredentials({ refreshToken: "" }, null)).resolves.toBeNull();
    });
  }

  it("calls refreshCodebuddyToken for codebuddy-cn when refresh token is present", async () => {
    const spy = vi.spyOn(providersModule, "refreshCodebuddyToken").mockResolvedValueOnce({
      accessToken: "new-cn-token",
      refreshToken: "new-cn-refresh",
      expiresIn: 3600,
    });
    const log = { info: vi.fn(), error: vi.fn() };

    const executor = new DefaultExecutor("codebuddy-cn");
    const result = await executor.refreshCredentials({ refreshToken: "test-refresh-cn" }, log);

    expect(result).toEqual({
      accessToken: "new-cn-token",
      refreshToken: "new-cn-refresh",
      expiresIn: 3600,
    });
    expect(spy).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("TOKEN", "codebuddy-cn refreshed");
    spy.mockRestore();
  });

  it("calls refreshCodebuddyIntlToken for codebuddy-intl when refresh token is present", async () => {
    const spy = vi.spyOn(providersModule, "refreshCodebuddyIntlToken").mockResolvedValueOnce({
      accessToken: "new-intl-token",
      refreshToken: "new-intl-refresh",
      expiresIn: 3600,
    });
    const log = { info: vi.fn(), error: vi.fn() };

    const executor = new DefaultExecutor("codebuddy-intl");
    const result = await executor.refreshCredentials({ refreshToken: "test-refresh-intl" }, log);

    expect(result).toEqual({
      accessToken: "new-intl-token",
      refreshToken: "new-intl-refresh",
      expiresIn: 3600,
    });
    expect(spy).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("TOKEN", "codebuddy-intl refreshed");
    spy.mockRestore();
  });
});
