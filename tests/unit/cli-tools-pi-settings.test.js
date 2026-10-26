import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

import {
  POST,
  GET,
  DELETE,
} from "../../src/app/api/cli-tools/pi-settings/route.js";

const {
  PI_CONTEXT_WINDOWS,
  PI_MAX_TOKENS,
  PI_DEFAULT_CAPS,
  PI_CAP_LIMITS,
  formatTokens,
  sanitizeCap,
  capOptions,
  readPiModels,
} = req("../../src/app/(dashboard)/dashboard/cli-tools/components/GenericCliToolCard.js");

describe("Pi CLI Settings & Model Caps (72cb589e)", () => {
  let tempDir;
  let origHome;
  let homedirSpy;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-pi-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempDir);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("GenericCliToolCard helpers", () => {
    it("sanitizeCap enforces positive finite numbers within maximum limit", () => {
      expect(sanitizeCap(200000, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap("400000", 200000, 2000000)).toBe(400000);
      expect(sanitizeCap(2000000, 200000, 2000000)).toBe(2000000);

      // Above limit -> fallback
      expect(sanitizeCap(2000001, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap(16384120000, 64000, 200000)).toBe(64000);

      // Zero, negative, non-finite -> fallback
      expect(sanitizeCap(0, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap(-100, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap(NaN, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap(Infinity, 200000, 2000000)).toBe(200000);
      expect(sanitizeCap("invalid", 200000, 2000000)).toBe(200000);
    });

    it("capOptions preserves current if included or inserts sorted", () => {
      expect(capOptions([200000, 400000, 600000], 400000)).toEqual([200000, 400000, 600000]);
      expect(capOptions([200000, 400000, 600000], 300000)).toEqual([200000, 300000, 400000, 600000]);
      expect(capOptions([200000, 400000, 600000], 100000)).toEqual([100000, 200000, 400000, 600000]);
      expect(capOptions([200000, 400000, 600000], 800000)).toEqual([200000, 400000, 600000, 800000]);
    });

    it("formatTokens formats token counts into k and M suffixes", () => {
      expect(formatTokens(16000)).toBe("16k");
      expect(formatTokens(64000)).toBe("64k");
      expect(formatTokens(200000)).toBe("200k");
      expect(formatTokens(1000000)).toBe("1M");
      expect(formatTokens(1500000)).toBe("1.5M");
      expect(formatTokens(2000000)).toBe("2M");
    });

    it("readPiModels parses model ids and caps from config", () => {
      expect(readPiModels(null)).toBeNull();
      expect(readPiModels({})).toBeNull();
      expect(readPiModels({ providers: {} })).toBeNull();

      const cfg = {
        providers: {
          "9router": {
            models: [
              "simple-model",
              {
                id: "custom-model",
                contextWindow: 400000,
                maxTokens: 32000,
              },
              {
                id: "corrupt-model",
                contextWindow: 99999999, // exceeds max -> fallback
                maxTokens: -5,           // <= 0 -> fallback
              },
            ],
          },
        },
      };

      const result = readPiModels(cfg);
      expect(result).not.toBeNull();
      expect(result.ids).toEqual(["simple-model", "custom-model", "corrupt-model"]);
      expect(result.caps["custom-model"]).toEqual({
        contextWindow: 400000,
        maxTokens: 32000,
      });
      expect(result.caps["corrupt-model"]).toEqual({
        contextWindow: PI_DEFAULT_CAPS.contextWindow,
        maxTokens: PI_DEFAULT_CAPS.maxTokens,
      });
    });
  });

  describe("POST /api/cli-tools/pi-settings", () => {
    it("returns 400 when baseUrl is missing", async () => {
      const req = new Request("http://localhost/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toBe("baseUrl is required");
    });

    it("creates ~/.pi/agent/models.json in temp home with default caps", async () => {
      const req = new Request("http://localhost/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:20128",
          apiKey: "test-key-123",
          models: ["anthropic/claude-3-7-sonnet"],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toContain("KhatamRouter");

      const modelsFile = path.join(tempDir, ".pi", "agent", "models.json");
      expect(fs.existsSync(modelsFile)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
      expect(parsed.providers["9router"]).toBeDefined();
      expect(parsed.providers["9router"].baseUrl).toBe("http://localhost:20128/v1");
      expect(parsed.providers["9router"].apiKey).toBe("test-key-123");
      expect(parsed.providers["9router"].models).toEqual([
        {
          id: "anthropic/claude-3-7-sonnet",
          name: "anthropic/claude-3-7-sonnet",
          contextWindow: 200000,
          maxTokens: 64000,
        },
      ]);
    });

    it("merges forward existing models by id and preserves custom caps", async () => {
      const agentDir = path.join(tempDir, ".pi", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const modelsFile = path.join(agentDir, "models.json");

      // Seed pre-existing models.json with custom caps and extra fields
      const initial = {
        providers: {
          "9router": {
            baseUrl: "http://localhost:20128/v1",
            apiKey: "existing-key",
            api: "openai-completions",
            models: [
              {
                id: "model-a",
                name: "Model Alpha Custom",
                contextWindow: 600000,
                maxTokens: 128000,
                customField: "keep-me",
              },
              {
                id: "model-b",
                name: "Model Beta",
                contextWindow: 400000,
                maxTokens: 32000,
              },
            ],
          },
        },
      };
      fs.writeFileSync(modelsFile, JSON.stringify(initial, null, 2), "utf-8");

      // Apply with model-a (bare string) and model-c (new with explicit caps)
      const req = new Request("http://localhost/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:20128",
          models: [
            "model-a",
            {
              id: "model-c",
              contextWindow: 1000000,
              maxTokens: 16000,
            },
          ],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
      const models = updated.providers["9router"].models;
      expect(models.length).toBe(2);

      // model-a: preserved customField, preserved custom caps
      const modelA = models.find((m) => m.id === "model-a");
      expect(modelA.customField).toBe("keep-me");
      expect(modelA.contextWindow).toBe(600000);
      expect(modelA.maxTokens).toBe(128000);

      // model-c: new model with explicit caps
      const modelC = models.find((m) => m.id === "model-c");
      expect(modelC.contextWindow).toBe(1000000);
      expect(modelC.maxTokens).toBe(16000);
    });

    it("sanitizes out-of-range caps to defaults (contextWindow <= 2M, maxTokens <= 200k)", async () => {
      const req = new Request("http://localhost/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:20128",
          models: [
            {
              id: "model-oversized",
              contextWindow: 5000000, // > 2M
              maxTokens: 999999,      // > 200k
            },
            {
              id: "model-concatenated",
              contextWindow: "16384120000", // corrupted string > 2M
              maxTokens: 0,                 // not > 0
            },
            {
              id: "model-negative",
              contextWindow: -1,
              maxTokens: -500,
            },
            {
              id: "model-exact-limits",
              contextWindow: 2000000, // exactly 2M -> valid
              maxTokens: 200000,      // exactly 200k -> valid
            },
          ],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const modelsFile = path.join(tempDir, ".pi", "agent", "models.json");
      const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
      const models = updated.providers["9router"].models;

      const oversized = models.find((m) => m.id === "model-oversized");
      expect(oversized.contextWindow).toBe(200000); // fallback
      expect(oversized.maxTokens).toBe(64000);      // fallback

      const concatenated = models.find((m) => m.id === "model-concatenated");
      expect(concatenated.contextWindow).toBe(200000); // fallback
      expect(concatenated.maxTokens).toBe(64000);      // fallback

      const negative = models.find((m) => m.id === "model-negative");
      expect(negative.contextWindow).toBe(200000); // fallback
      expect(negative.maxTokens).toBe(64000);      // fallback

      const exact = models.find((m) => m.id === "model-exact-limits");
      expect(exact.contextWindow).toBe(2000000);
      expect(exact.maxTokens).toBe(200000);
    });

    describe("model name preservation across Apply (50dcaa0c)", () => {
      it("preserves hand-set display name when card sends name === id", async () => {
        const agentDir = path.join(tempDir, ".pi", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        const modelsFile = path.join(agentDir, "models.json");

        const initial = {
          providers: {
            "9router": {
              baseUrl: "http://localhost:20128/v1",
              apiKey: "test-key",
              models: [
                {
                  id: "anthropic/claude-3-7-sonnet",
                  name: "Claude 3.7 Sonnet (Hand-Crafted Alias)",
                  contextWindow: 200000,
                  maxTokens: 64000,
                },
              ],
            },
          },
        };
        fs.writeFileSync(modelsFile, JSON.stringify(initial, null, 2), "utf-8");

        // The card sends name === id for each model
        const req = new Request("http://localhost/api/cli-tools/pi-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "http://localhost:20128",
            models: [
              {
                id: "anthropic/claude-3-7-sonnet",
                name: "anthropic/claude-3-7-sonnet", // card format
                contextWindow: 400000,
                maxTokens: 64000,
              },
            ],
          }),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
        const model = updated.providers["9router"].models[0];
        expect(model.id).toBe("anthropic/claude-3-7-sonnet");
        // Hand-set display name is retained because name === id is treated as "unset"
        expect(model.name).toBe("Claude 3.7 Sonnet (Hand-Crafted Alias)");
        // But caps update took effect
        expect(model.contextWindow).toBe(400000);
      });

      it("preserves hand-set display name when caller sends bare model id string", async () => {
        const agentDir = path.join(tempDir, ".pi", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        const modelsFile = path.join(agentDir, "models.json");

        const initial = {
          providers: {
            "9router": {
              baseUrl: "http://localhost:20128/v1",
              models: [
                {
                  id: "openai/gpt-4o",
                  name: "GPT-4o Custom Label",
                  contextWindow: 128000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        };
        fs.writeFileSync(modelsFile, JSON.stringify(initial, null, 2), "utf-8");

        const req = new Request("http://localhost/api/cli-tools/pi-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "http://localhost:20128",
            models: ["openai/gpt-4o"],
          }),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
        const model = updated.providers["9router"].models[0];
        expect(model.name).toBe("GPT-4o Custom Label");
      });

      it("allows an explicitly different name to override previous name", async () => {
        const agentDir = path.join(tempDir, ".pi", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        const modelsFile = path.join(agentDir, "models.json");

        const initial = {
          providers: {
            "9router": {
              baseUrl: "http://localhost:20128/v1",
              models: [
                {
                  id: "google/gemini-2.5-pro",
                  name: "Old Display Name",
                  contextWindow: 1000000,
                  maxTokens: 64000,
                },
              ],
            },
          },
        };
        fs.writeFileSync(modelsFile, JSON.stringify(initial, null, 2), "utf-8");

        // Caller provides an explicit new name that is different from id
        const req = new Request("http://localhost/api/cli-tools/pi-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "http://localhost:20128",
            models: [
              {
                id: "google/gemini-2.5-pro",
                name: "Updated Gemini 2.5 Pro",
              },
            ],
          }),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
        const model = updated.providers["9router"].models[0];
        expect(model.name).toBe("Updated Gemini 2.5 Pro");
      });
    });
  });

  describe("GET and DELETE /api/cli-tools/pi-settings", () => {
    it("GET reports installed=true and has9Router when models.json has 9router provider", async () => {
      const agentDir = path.join(tempDir, ".pi", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const modelsFile = path.join(agentDir, "models.json");
      fs.writeFileSync(
        modelsFile,
        JSON.stringify({
          providers: {
            "9router": {
              baseUrl: "http://localhost:20128/v1",
              models: [{ id: "test-model" }],
            },
          },
        }),
        "utf-8"
      );

      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.installed).toBe(true);
      expect(data.has9Router).toBe(true);
      expect(data.config).toBeDefined();
    });

    it("DELETE removes 9router provider from models.json and returns KhatamRouter toast", async () => {
      const agentDir = path.join(tempDir, ".pi", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const modelsFile = path.join(agentDir, "models.json");
      fs.writeFileSync(
        modelsFile,
        JSON.stringify({
          providers: {
            "9router": {
              baseUrl: "http://localhost:20128/v1",
              models: [{ id: "test-model" }],
            },
            other: {
              baseUrl: "https://api.openai.com/v1",
            },
          },
        }),
        "utf-8"
      );

      const res = await DELETE();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe("KhatamRouter removed from Pi");

      const updated = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
      expect(updated.providers["9router"]).toBeUndefined();
      expect(updated.providers.other).toBeDefined();
    });
  });
});
