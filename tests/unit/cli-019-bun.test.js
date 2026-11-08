import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const lp = require("../../cli/src/cli/utils/launcherProcess.js");
const { listTtsVoices } = require("../../src/lib/ttsVoices.js");
const {
  buildModelGroups,
  collectModelValues,
  NO_AUTH_PROVIDER_IDS,
  LIVE_CATALOG_PROVIDERS,
} = require("../../src/shared/utils/selectableModels.js");
const {
  assertDeepSeekPowFiles,
  copyDeepSeekPowFiles,
} = require("../../cli/scripts/build-cli.js");

describe("Leaf 2.4 Bun-only toolchain & CLI hardening", () => {
  const rootDir = path.resolve(__dirname, "../..");

  it("shebang of cli/cli.js specifies bun", () => {
    const cliPath = path.join(rootDir, "cli/cli.js");
    const firstLine = fs.readFileSync(cliPath, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env bun");
  });

  it("cli/cli.js has zero references to sqliteRuntime or Node sqlite drivers", () => {
    const cliSrc = fs.readFileSync(path.join(rootDir, "cli/cli.js"), "utf8");
    expect(cliSrc).not.toContain("sqliteRuntime");
    expect(cliSrc).not.toContain("better-sqlite3");
    expect(cliSrc).not.toContain("node:sqlite");
    expect(cliSrc).not.toContain("sql.js");
  });

  it("cli/cli.js spawns the server using bun", () => {
    const cliSrc = fs.readFileSync(path.join(rootDir, "cli/cli.js"), "utf8");
    expect(cliSrc).toContain('spawn("bun", [serverPath]');
  });

  it("cli/hooks/trayRuntime.js uses Bun exclusively", () => {
    const trayRuntimeSrc = fs.readFileSync(path.join(rootDir, "cli/hooks/trayRuntime.js"), "utf8");
    expect(trayRuntimeSrc).not.toContain("npm install");
    expect(trayRuntimeSrc).not.toContain("npx");
    expect(trayRuntimeSrc).toContain("runBunAdd");
    expect(trayRuntimeSrc).toContain("bun.exe");
  });

  it("PID reuse protection: never kills unrelated processes with a reused PID", () => {
    const killed = [];
    const record = {
      cliPid: 12345,
      serverPid: 67890,
      port: 20128,
      exe: "bun",
    };

    // Simulate scenario: PID 12345 is still alive, but its executable is now "chrome" or "bash"
    const result = lp.stopRecordedInstance(record, {
      selfPid: 99999,
      isAlive: () => true,
      matchesExe: (pid, exe) => {
        // Only allow if process executable actually matches "bun"
        return false; // Simulated PID reuse by another application
      },
      killPid: (pid) => killed.push(pid),
    });

    // Neither PID should be killed because matchesExe failed
    expect(killed).toEqual([]);
    expect(result).toEqual([]);
  });

  it("PID reuse protection: correctly kills only processes that match the recorded exe", () => {
    const killed = [];
    const record = {
      cliPid: 12345,
      serverPid: 67890,
      port: 20128,
      exe: "bun",
    };

    // Simulate scenario: server is bun, but CLI was reused by another program
    const result = lp.stopRecordedInstance(record, {
      selfPid: 99999,
      isAlive: () => true,
      matchesExe: (pid, exe) => pid === 67890, // only server is bun
      killPid: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([67890]);
    expect(result).toEqual([67890]);
  });

  it("PoW worker and hash files are exported from build-cli.js", () => {
    expect(typeof copyDeepSeekPowFiles).toBe("function");
    expect(typeof assertDeepSeekPowFiles).toBe("function");
  });

  it("TTS shared in-process service contains no internal HTTP self-fetch", () => {
    const ttsSrc = fs.readFileSync(path.join(rootDir, "src/lib/ttsVoices.js"), "utf8");
    expect(ttsSrc).not.toContain("fetch(");
    expect(typeof listTtsVoices).toBe("function");
  });

  it("Add All Active Models utilities provide expected constants and functions", () => {
    expect(Array.isArray(NO_AUTH_PROVIDER_IDS)).toBe(true);
    expect(Array.isArray(LIVE_CATALOG_PROVIDERS)).toBe(true);
    expect(typeof buildModelGroups).toBe("function");
    expect(typeof collectModelValues).toBe("function");
  });
});
