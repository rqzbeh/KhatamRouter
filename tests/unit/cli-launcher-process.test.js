import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";

const require = createRequire(import.meta.url);
const lp = require("../../cli/src/cli/utils/launcherProcess.js");

const EXE = path.basename(process.execPath);

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("launcher PID record", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pid-"));
    file = lp.getPidFilePath(path.join(dir, "nested"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("places the record under the data dir", () => {
    expect(file).toBe(path.join(dir, "nested", "launcher.pid"));
  });

  it("round-trips a record and creates the data dir", () => {
    const record = {
      cliPid: 111,
      serverPid: 222,
      port: 20128,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    };
    lp.writePidRecord(file, record);
    expect(lp.readPidRecord(file)).toEqual(record);
  });

  it("returns null when the record is missing", () => {
    expect(lp.readPidRecord(file)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(lp.readPidRecord(file)).toBeNull();
  });

  it("returns null when PIDs are not positive integers", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cliPid: "1; rm -rf /", serverPid: -4, exe: EXE }));
    expect(lp.readPidRecord(file)).toBeNull();
  });

  it("drops an invalid serverPid but keeps a valid cliPid and entrypoints", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      cliPid: 5,
      serverPid: "x",
      port: 1,
      exe: EXE,
      cliEntry: "/khatam/cli.js",
      serverEntry: 12345, // invalid type dropped
    }));
    expect(lp.readPidRecord(file)).toEqual({
      cliPid: 5,
      serverPid: null,
      port: 1,
      exe: EXE,
      cliEntry: "/khatam/cli.js",
    });
  });

  it("removes the record only for its owner", () => {
    lp.writePidRecord(file, { cliPid: 111, serverPid: 222, port: 1, exe: EXE });
    lp.removePidRecordIfOwner(file, 999);
    expect(fs.existsSync(file)).toBe(true);
    lp.removePidRecordIfOwner(file, 111);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(lp.isPidAlive(process.pid)).toBe(true);
  });

  it("is false when the signal probe reports ESRCH", () => {
    const kill = () => { const e = new Error("no such process"); e.code = "ESRCH"; throw e; };
    expect(lp.isPidAlive(1234, { kill })).toBe(false);
  });

  it("is true when the probe reports EPERM (alive, owned by another user)", () => {
    const kill = () => { const e = new Error("not permitted"); e.code = "EPERM"; throw e; };
    expect(lp.isPidAlive(1234, { kill })).toBe(true);
  });

  it("is false for invalid PIDs without probing", () => {
    const kill = () => { throw new Error("should not be called"); };
    expect(lp.isPidAlive(0, { kill })).toBe(false);
    expect(lp.isPidAlive(null, { kill })).toBe(false);
  });
});

describe("stopRecordedInstance", () => {
  const deps = (overrides = {}) => {
    const killed = [];
    return {
      killed,
      opts: {
        selfPid: 1,
        isAlive: () => true,
        matchesExe: () => true,
        killPid: (pid) => killed.push(pid),
        ...overrides,
      },
    };
  };

  it("kills the recorded server and CLI", () => {
    const { killed, opts } = deps();
    const result = lp.stopRecordedInstance({
      cliPid: 10,
      serverPid: 20,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    }, opts);
    expect(killed).toEqual([20, 10]);
    expect(result).toEqual([20, 10]);
  });

  it("never kills itself", () => {
    const { killed, opts } = deps({ selfPid: 10 });
    lp.stopRecordedInstance({
      cliPid: 10,
      serverPid: 20,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    }, opts);
    expect(killed).toEqual([20]);
  });

  it("skips PIDs that are no longer alive", () => {
    const { killed, opts } = deps({ isAlive: (pid) => pid === 20 });
    lp.stopRecordedInstance({
      cliPid: 10,
      serverPid: 20,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    }, opts);
    expect(killed).toEqual([20]);
  });

  it("skips a reused PID that now belongs to a different program", () => {
    const { killed, opts } = deps({ matchesExe: (pid) => pid !== 10 });
    lp.stopRecordedInstance({
      cliPid: 10,
      serverPid: 20,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    }, opts);
    expect(killed).toEqual([20]);
  });

  it("does nothing for a null record", () => {
    const { killed, opts } = deps();
    expect(lp.stopRecordedInstance(null, opts)).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("keeps going when one kill throws", () => {
    const { opts } = deps({ killPid: (pid) => { if (pid === 20) throw new Error("denied"); } });
    expect(lp.stopRecordedInstance({
      cliPid: 10,
      serverPid: 20,
      exe: EXE,
      cliEntry: "/khatam/cli/cli.js",
      serverEntry: "/khatam/cli/app/server.js",
    }, opts)).toEqual([10]);
  });

  it("fails closed on legacy record with exe only and refuses to kill", () => {
    // Production matcher without mock: legacy records with only exe must not kill
    const record = { cliPid: 10, serverPid: 20, exe: EXE };
    const killed = [];
    const result = lp.stopRecordedInstance(record, {
      selfPid: 1,
      isAlive: () => true,
      killPid: (pid) => killed.push(pid),
    });
    expect(result).toEqual([]);
    expect(killed).toEqual([]);
  });
});

describe("real process identity & PID reuse safety (production matcher)", () => {
  let tmpDir;
  const spawnedProcesses = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-proc-test-"));
  });

  afterEach(() => {
    for (const p of spawnedProcesses) {
      try { p.kill("SIGKILL"); } catch {}
    }
    spawnedProcesses.length = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses to kill an unrelated Bun process (e.g. bun -e) even with matching exe name", async () => {
    const unrelated = spawn("bun", ["-e", "setInterval(() => {}, 1000);"]);
    spawnedProcesses.push(unrelated);
    await new Promise((r) => setTimeout(r, 80));

    expect(lp.isPidAlive(unrelated.pid)).toBe(true);

    // Stale PID record pointing to this unrelated Bun process with a Khatam entrypoint
    const staleRecord = {
      cliPid: unrelated.pid,
      serverPid: null,
      port: 20128,
      exe: EXE,
      cliEntry: "/tmp/some/other/khatam/cli.js",
    };

    // Calling stopRecordedInstance with production processMatchesExe (no mock!)
    const killed = lp.stopRecordedInstance(staleRecord);
    expect(killed).toEqual([]);
    expect(lp.isPidAlive(unrelated.pid)).toBe(true);
  });

  it("refuses to kill a Bun process with identical parent/basename in a different directory", async () => {
    // Create /diff/cli/cli.js (same relative parent and basename: cli/cli.js)
    const diffDir = path.join(tmpDir, "diff", "cli");
    fs.mkdirSync(diffDir, { recursive: true });
    const diffScript = path.join(diffDir, "cli.js");
    fs.writeFileSync(diffScript, "setInterval(() => {}, 1000);");

    const diffProc = spawn("bun", [diffScript]);
    spawnedProcesses.push(diffProc);
    await new Promise((r) => setTimeout(r, 80));

    // Expected entrypoint is /target/cli/cli.js
    const targetScript = path.join(tmpDir, "target", "cli", "cli.js");

    expect(lp.processMatchesExe(diffProc.pid, EXE, targetScript)).toBe(false);

    const record = {
      cliPid: diffProc.pid,
      serverPid: null,
      port: 20128,
      exe: EXE,
      cliEntry: targetScript,
    };
    expect(lp.stopRecordedInstance(record)).toEqual([]);
    expect(lp.isPidAlive(diffProc.pid)).toBe(true);
  });

  it("refuses to match when a process argument merely mentions the expected entrypoint", async () => {
    const expectedScript = path.join(tmpDir, "expected-server.js");
    fs.writeFileSync(expectedScript, "setInterval(() => {}, 1000);");

    // Process is running an unrelated script, but passes --config=/path/expected-server.js
    const unrelated = spawn("bun", ["-e", "setInterval(() => {}, 1000);", `--config=${expectedScript}`]);
    spawnedProcesses.push(unrelated);
    await new Promise((r) => setTimeout(r, 80));

    expect(lp.processMatchesExe(unrelated.pid, EXE, expectedScript)).toBe(false);
  });

  it("refuses to match when --preload or --config flag consumes the expected path as a value", async () => {
    const expectedScript = path.join(tmpDir, "expected-server.js");
    const otherScript = path.join(tmpDir, "other-script.js");
    fs.writeFileSync(expectedScript, "setInterval(() => {}, 1000);");
    fs.writeFileSync(otherScript, "setInterval(() => {}, 1000);");

    // Process runs other-script.js with --preload expected-server.js
    const procWithPreload = spawn("bun", ["--preload", expectedScript, otherScript]);
    spawnedProcesses.push(procWithPreload);
    await new Promise((r) => setTimeout(r, 80));

    // The script being run is otherScript, so expectedScript must NOT match
    expect(lp.processMatchesExe(procWithPreload.pid, EXE, expectedScript)).toBe(false);

    // Verify parser directly against flag values
    expect(lp.verifyExactScriptEntry(["bun", "--preload", expectedScript, otherScript], expectedScript, tmpDir)).toBe(false);
    expect(lp.verifyExactScriptEntry(["bun", "--config", expectedScript, otherScript], expectedScript, tmpDir)).toBe(false);
  });

  it("fails closed when script argument is relative but process working directory is unprovable", () => {
    const targetScript = path.join(tmpDir, "server.js");

    // Relative scriptArg with procCwd = null must fail closed (never assume current process.cwd)
    expect(lp.verifyExactScriptEntry(["bun", "server.js"], targetScript, null)).toBe(false);
    expect(lp.verifyExactScriptEntry(["bun", "./server.js"], targetScript, null)).toBe(false);

    // Relative scriptArg WITH valid matching procCwd succeeds
    expect(lp.verifyExactScriptEntry(["bun", "server.js"], targetScript, tmpDir)).toBe(true);
  });

  it("successfully terminates a matching own fixture process", async () => {
    const fixtureScript = path.join(tmpDir, "matching-server.js");
    fs.writeFileSync(fixtureScript, "setInterval(() => {}, 1000);");

    const matchingProc = spawn("bun", [fixtureScript]);
    spawnedProcesses.push(matchingProc);
    await new Promise((r) => setTimeout(r, 80));

    expect(lp.isPidAlive(matchingProc.pid)).toBe(true);
    expect(lp.processMatchesExe(matchingProc.pid, EXE, fixtureScript)).toBe(true);

    const record = {
      cliPid: 9999999, // non-existent
      serverPid: matchingProc.pid,
      port: 20128,
      exe: EXE,
      serverEntry: fixtureScript,
    };

    const killed = lp.stopRecordedInstance(record);
    expect(killed).toEqual([matchingProc.pid]);
    await lp.waitForPidsExit([matchingProc.pid], { timeoutMs: 2000 });
    expect(lp.isPidAlive(matchingProc.pid)).toBe(false);
  });
});

describe("port helpers", () => {
  it("isPortInUse is true for a listening port and false once closed", async () => {
    const server = await listen();
    const { port } = server.address();
    expect(await lp.isPortInUse(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await lp.isPortInUse(port)).toBe(false);
  });

  it("waitForPortFree resolves immediately when the port is already free", async () => {
    const server = await listen();
    const { port } = server.address();
    await new Promise((r) => server.close(r));
    const start = Date.now();
    expect(await lp.waitForPortFree(port, { timeoutMs: 2000 })).toBe(true);
    expect(Date.now() - start).toBeLessThan(400);
  });

  it("waitForPortFree resolves as soon as the port is released", async () => {
    const server = await listen();
    const { port } = server.address();
    setTimeout(() => server.close(), 200);
    const start = Date.now();
    expect(await lp.waitForPortFree(port, { timeoutMs: 3000, intervalMs: 50 })).toBe(true);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
  });

  it("waitForPortFree gives up after the timeout", async () => {
    const server = await listen();
    const { port } = server.address();
    try {
      expect(await lp.waitForPortFree(port, { timeoutMs: 300, intervalMs: 50 })).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("waitForPidsExit", () => {
  it("resolves immediately when nothing is alive", async () => {
    const start = Date.now();
    expect(await lp.waitForPidsExit([1, 2], { isAlive: () => false })).toBe(true);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("resolves once all PIDs exit", async () => {
    let alive = true;
    setTimeout(() => { alive = false; }, 150);
    expect(await lp.waitForPidsExit([1], { isAlive: () => alive, intervalMs: 25, timeoutMs: 2000 })).toBe(true);
  });

  it("gives up after the timeout", async () => {
    expect(await lp.waitForPidsExit([1], { isAlive: () => true, intervalMs: 25, timeoutMs: 150 })).toBe(false);
  });
});
