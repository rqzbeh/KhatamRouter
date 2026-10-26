import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";

// Import modules under test from cli/src/ts/
import {
  parseArgs,
  dispatch,
  ensureBun,
  findBunExecutable,
  formatBunPrerequisiteError,
  statusCommand,
  pingCommand,
  stopCommand,
  maskKey,
  maskSecrets,
} from "../../cli/src/ts/index.ts";

describe("Consolidated TypeScript CLI", () => {
  describe("G1: Dispatch and Parsing", () => {
    describe("Types and Parsing", () => {
      it("parses default options when no arguments provided", () => {
        const parsed = parseArgs([]);
        expect(parsed.command).toBe("start");
        expect(parsed.port).toBe(20128);
        expect(parsed.host).toBe("0.0.0.0");
        expect(parsed.noBrowser).toBe(false);
        expect(parsed.json).toBe(false);
      });

      it("parses custom --port, --host, and --no-browser flags", () => {
        const parsed = parseArgs(["--port", "20130", "--host", "127.0.0.1", "--no-browser"]);
        expect(parsed.command).toBe("start");
        expect(parsed.port).toBe(20130);
        expect(parsed.host).toBe("127.0.0.1");
        expect(parsed.noBrowser).toBe(true);
      });

      it("parses short -p flag for port", () => {
        const parsed = parseArgs(["-p", "8080"]);
        expect(parsed.port).toBe(8080);
      });

      it("parses subcommands: status, ping, stop, show, connect, xai", () => {
        expect(parseArgs(["status"]).command).toBe("status");
        expect(parseArgs(["ping"]).command).toBe("ping");
        expect(parseArgs(["stop"]).command).toBe("stop");
        expect(parseArgs(["show"]).command).toBe("show");
        expect(parseArgs(["connect", "http://localhost:20128"]).command).toBe("connect");
        expect(parseArgs(["xai", "video"]).command).toBe("xai");
      });

      it("parses --json and --data-dir flags", () => {
        const parsed = parseArgs(["status", "--json", "--data-dir", "/tmp/9r-test", "--port", "20129"]);
        expect(parsed.command).toBe("status");
        expect(parsed.json).toBe(true);
        expect(parsed.dataDir).toBe("/tmp/9r-test");
        expect(parsed.port).toBe(20129);
      });

      it("parses --help and --version flags", () => {
        expect(parseArgs(["--help"]).help).toBe(true);
        expect(parseArgs(["-h"]).help).toBe(true);
        expect(parseArgs(["--version"]).version).toBe(true);
        expect(parseArgs(["-v"]).version).toBe(true);
      });

      it("rejects invalid port numbers", () => {
        expect(() => parseArgs(["--port", "-1"])).toThrow(/Invalid port/);
        expect(() => parseArgs(["--port", "999999"])).toThrow(/Invalid port/);
        expect(() => parseArgs(["--port", "notanumber"])).toThrow(/Invalid port/);
      });
    });

    describe("Command Dispatch", () => {
      it("dispatches help and version without errors", async () => {
        const out = [];
        const logger = (msg) => out.push(msg);

        const helpRes = await dispatch(["--help"], { stdout: logger });
        expect(helpRes.exitCode).toBe(0);
        expect(out.join("\n")).toContain("KhatamRouter");

        out.length = 0;
        const verRes = await dispatch(["--version"], { stdout: logger });
        expect(verRes.exitCode).toBe(0);
        expect(out.join("\n")).toMatch(/\d+\.\d+\.\d+/);
      });

      it("dispatches show subcommand delegating to show handler", async () => {
        const showMock = vi.fn().mockResolvedValue(0);
        const res = await dispatch(["show", "claude"], { delegates: { show: showMock } });
        expect(showMock).toHaveBeenCalledWith(["claude"]);
        expect(res.exitCode).toBe(0);
      });

      it("dispatches connect subcommand delegating to connect handler", async () => {
        const connectMock = vi.fn().mockResolvedValue(0);
        const res = await dispatch(["connect", "http://localhost:20128", "--key", "sk-1234"], {
          delegates: { connect: connectMock },
        });
        expect(connectMock).toHaveBeenCalledWith(["http://localhost:20128", "--key", "sk-1234"]);
        expect(res.exitCode).toBe(0);
      });

      it("dispatches xai subcommand delegating to xaiVideo handler", async () => {
        const xaiMock = vi.fn().mockResolvedValue(0);
        const res = await dispatch(["xai", "video", "--prompt", "test"], {
          delegates: { xaiVideo: xaiMock },
        });
        expect(xaiMock).toHaveBeenCalledWith(["--prompt", "test"]);
        expect(res.exitCode).toBe(0);
      });

      it("dispatches start command with launcher delegate", async () => {
        const startMock = vi.fn().mockResolvedValue(0);
        const res = await dispatch(["--port", "20128", "--no-browser"], {
          delegates: { start: startMock },
        });
        expect(startMock).toHaveBeenCalledWith(
          expect.objectContaining({ port: 20128, noBrowser: true })
        );
        expect(res.exitCode).toBe(0);
      });

      it("returns error code for unknown subcommands", async () => {
        const errs = [];
        const res = await dispatch(["unknown-command"], { stderr: (m) => errs.push(m) });
        expect(res.exitCode).toBe(1);
        expect(errs.join("\n")).toContain("Unknown command");
      });

      it("bundles TypeScript CLI core via esbuild in build-cli script", () => {
        const { createRequire } = require("node:module");
        const nodeRequire = createRequire(import.meta.url);
        const fs = nodeRequire("node:fs");
        const path = nodeRequire("node:path");
        const os = nodeRequire("node:os");
        const { buildTypeScriptCli } = nodeRequire("../../cli/scripts/build-cli.js");

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ts-build-"));
        try {
          buildTypeScriptCli({ outdir: tempDir });
          const bundlePath = path.join(tempDir, "index.js");
          expect(fs.existsSync(bundlePath)).toBe(true);

          const bundled = nodeRequire(bundlePath);
          expect(typeof bundled.dispatch).toBe("function");
          expect(typeof bundled.parseArgs).toBe("function");
          expect(typeof bundled.ensureBun).toBe("function");
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("G2: EnsureBun and Prerequisite Checks", () => {
    it("findBunExecutable returns a string when bun is available", () => {
      const bun = findBunExecutable();
      // Test is executed via Bun runtime
      expect(typeof bun).toBe("string");
      expect(bun.length).toBeGreaterThan(0);
    });

    it("ensureBun returns executable path when findBun finds runtime", () => {
      const res = ensureBun({ findBun: () => "/custom/bin/bun" });
      expect(res).toBe("/custom/bin/bun");
    });

    it("ensureBun aborts with exit code 1 and prints verbatim guidance when bun is missing", () => {
      const stderr = [];
      let exitCode = null;

      ensureBun({
        findBun: () => null,
        stderr: (msg) => stderr.push(msg),
        exit: (code) => {
          exitCode = code;
        },
      });

      expect(exitCode).toBe(1);
      const text = stderr.join("\n");
      expect(text).toContain("Error: Bun runtime is required to run KhatamRouter.");
      expect(text).toContain("Starting with Wave 7.5, KhatamRouter runs exclusively on Bun (bun:sqlite)");
      expect(text).toContain("and no longer supports Node-only execution.");
      expect(text).toContain("Please install Bun from https://bun.sh:");
      expect(text).toContain("curl -fsSL https://bun.sh/install | bash");
      expect(text).toContain('powershell -c "irm bun.sh/install.ps1 | iex"');
      expect(text).toContain("npm install -g bun");
      expect(text).toContain("Visit https://bun.sh for detailed installation instructions.");
    });

    it("formatBunPrerequisiteError returns structured guidance string", () => {
      const guidance = formatBunPrerequisiteError();
      expect(guidance).toContain("Bun runtime is required");
      expect(guidance).toContain("https://bun.sh");
      expect(guidance).toContain("bun:sqlite");
    });
  });

  describe("G3: Status, Ping and SecretMasking", () => {
    describe("SecretMasking", () => {
      it("masks standard sk- API keys preserving prefix and last 4 characters", () => {
        expect(maskKey("sk-sho-test-key-123456789")).toBe("sk-sho…6789");
        expect(maskKey("sk-abc123456789xyz")).toBe("sk-abc…9xyz");
      });

      it("masks short keys or invalid keys with asterisks", () => {
        expect(maskKey("short")).toBe("****");
        expect(maskKey("")).toBe("****");
        expect(maskKey(null)).toBe("****");
        expect(maskKey(undefined)).toBe("****");
      });

      it("recursively masks sensitive keys in objects and arrays", () => {
        const input = {
          name: "test-config",
          apiKey: "sk-sho-test-key-123456789",
          nested: {
            token: "secret-token-value-12345678",
            password: "super-secret-password-xyz",
            normalField: "visible",
            list: ["safe", "sk-sho-test-key-123456789"],
          },
        };

        const masked = maskSecrets(input);
        expect(masked.apiKey).toBe("sk-sho…6789");
        expect(masked.nested.token).toBe("secret…5678");
        expect(masked.nested.password).toBe("super-…-xyz");
        expect(masked.nested.normalField).toBe("visible");
        expect(masked.nested.list[0]).toBe("safe");
        expect(masked.nested.list[1]).toBe("sk-sho…6789");
      });
    });

    describe("Status and Ping against real HTTP server", () => {
      let server;
      let serverPort;

      beforeEach(async () => {
        // Start a mock local HTTP server
        await new Promise((resolve) => {
          server = http.createServer((req, res) => {
            if (req.url === "/api/health" && req.method === "GET") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, version: "0.5.104", pid: process.pid, uptime: 42 }));
            } else if (req.url === "/api/shutdown" && req.method === "POST") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, message: "Shutting down..." }));
            } else {
              res.writeHead(404);
              res.end();
            }
          });
          server.listen(0, "127.0.0.1", () => {
            serverPort = server.address().port;
            resolve();
          });
        });
      });

      afterEach(async () => {
        if (server) {
          await new Promise((resolve) => server.close(resolve));
        }
      });

      it("statusCommand reports online status against reachable server", async () => {
        const out = [];
        const res = await statusCommand({
          port: serverPort,
          host: "127.0.0.1",
          stdout: (m) => out.push(m),
        });

        expect(res.exitCode).toBe(0);
        expect(res.data.online).toBe(true);
        expect(res.data.port).toBe(serverPort);
        expect(out.join("\n")).toContain("online");
      });

      it("statusCommand supports --json output format", async () => {
        const out = [];
        const res = await statusCommand({
          port: serverPort,
          host: "127.0.0.1",
          json: true,
          stdout: (m) => out.push(m),
        });

        expect(res.exitCode).toBe(0);
        const parsed = JSON.parse(out.join("\n"));
        expect(parsed.online).toBe(true);
        expect(parsed.port).toBe(serverPort);
      });

      it("statusCommand handles offline gateway gracefully", async () => {
        const out = [];
        // Port 1 is reserved and closed
        const res = await statusCommand({
          port: 1,
          host: "127.0.0.1",
          timeoutMs: 500,
          stdout: (m) => out.push(m),
          stderr: (m) => out.push(m),
        });

        expect(res.data.online).toBe(false);
        expect(out.join("\n")).toContain("offline");
      });

      it("pingCommand verifies TCP and HTTP ping successfully", async () => {
        const out = [];
        const res = await pingCommand({
          port: serverPort,
          host: "127.0.0.1",
          timeoutMs: 1000,
          stdout: (m) => out.push(m),
        });

        expect(res.exitCode).toBe(0);
        expect(res.data.tcp).toBe(true);
        expect(res.data.http).toBe(true);
        expect(out.join("\n")).toContain("pong");
      });

      it("pingCommand reports failure when gateway is not reachable", async () => {
        const out = [];
        const res = await pingCommand({
          port: 1,
          host: "127.0.0.1",
          timeoutMs: 500,
          stdout: (m) => out.push(m),
          stderr: (m) => out.push(m),
        });

        expect(res.exitCode).toBe(1);
        expect(res.data.tcp).toBe(false);
      });

      it("stopCommand sends shutdown request to running server", async () => {
        const out = [];
        const res = await stopCommand({
          port: serverPort,
          host: "127.0.0.1",
          stdout: (m) => out.push(m),
        });

        expect(res.exitCode).toBe(0);
        expect(res.data.success).toBe(true);
        expect(out.join("\n")).toContain("Shutdown");
      });
    });
  });
});
