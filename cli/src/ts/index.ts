import fs from "node:fs";
import path from "node:path";
import type {
  CliCommandName,
  CliCommandResult,
  CliServerOptions,
  DispatchOptions,
  ParsedCliArgs,
} from "./types.ts";
import { ensureBun, findBunExecutable, formatBunPrerequisiteError } from "./utils/prerequisite.ts";
import { maskKey, maskSecrets } from "./utils/mask.ts";
import { statusCommand } from "./commands/status.ts";
import { pingCommand } from "./commands/ping.ts";
import { stopCommand } from "./commands/stop.ts";

export * from "./types.ts";
export * from "./utils/prerequisite.ts";
export * from "./utils/mask.ts";
export * from "./commands/status.ts";
export * from "./commands/ping.ts";
export * from "./commands/stop.ts";

function getSemverHelper(): { reconstructSemver: (v: string) => string | null } {
  try {
    const req = typeof require !== "undefined" ? require : (globalThis as any).require;
    if (req) {
      return req("../cli/utils/semver");
    }
  } catch {}
  return {
    reconstructSemver: (v: string) => {
      const match = v.match(/^v?(\d+\.\d+\.\d+)/);
      return match ? match[1] : v;
    },
  };
}

function getPackageVersion(): string {
  try {
    const candidates = [
      path.resolve(__dirname, "../../package.json"),
      path.resolve(__dirname, "../package.json"),
      path.resolve(process.cwd(), "cli/package.json"),
      path.resolve(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (parsed.version) return parsed.version;
      }
    }
  } catch {}
  return "0.5.104";
}

const { reconstructSemver } = getSemverHelper();

const KNOWN_SUBCOMMANDS = new Set<string>([
  "start",
  "status",
  "ping",
  "stop",
  "show",
  "connect",
  "xai",
]);

const HELP_TEXT = `
KhatamRouter CLI — Local AI gateway and dashboard launcher

Usage:
  khatamrouter [command] [options]

Commands:
  start               Start gateway server and open dashboard (default)
  status              Check gateway running status and operational metrics
  ping                Verify TCP connection and HTTP ping to gateway
  stop                Gracefully shut down local gateway instance
  show [tool...]      Display local CLI tools configuration (masked keys)
  connect <url>       Configure local CLI tools against target gateway
  xai video ...       Generate AI video via xAI endpoint

Options:
  --port, -p <number> Gateway port (default: 20128)
  --host <string>     Gateway bind host (default: 0.0.0.0)
  --no-browser        Do not open browser on startup
  --data-dir <path>   Custom data directory (default: ~/.9router)
  --json              Output in machine-readable JSON format
  -h, --help          Show help information
  -v, --version       Show version number
`;

/**
 * Parses raw CLI arguments into typed options and commands.
 */
export function parseArgs(argv: string[]): ParsedCliArgs {
  let command: CliCommandName = "start";
  let port = 20128;
  let host = "0.0.0.0";
  let noBrowser = false;
  let json = false;
  let help = false;
  let version = false;
  let dataDir: string | undefined;
  const subcommandArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg === "--no-browser") {
      noBrowser = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--port" || arg === "-p") {
      const val = argv[++i];
      if (!val) {
        throw new Error("Missing value for --port");
      }
      const num = Number(val);
      if (!Number.isInteger(num) || num <= 0 || num > 65535) {
        throw new Error(`Invalid port: ${val}. Must be an integer between 1 and 65535.`);
      }
      port = num;
    } else if (arg === "--host") {
      const val = argv[++i];
      if (!val) {
        throw new Error("Missing value for --host");
      }
      host = val;
    } else if (arg === "--data-dir") {
      const val = argv[++i];
      if (!val) {
        throw new Error("Missing value for --data-dir");
      }
      dataDir = val;
    } else if (!arg.startsWith("-")) {
      if (KNOWN_SUBCOMMANDS.has(arg) && subcommandArgs.length === 0) {
        command = arg as CliCommandName;
      } else {
        subcommandArgs.push(arg);
      }
    } else {
      subcommandArgs.push(arg);
    }
  }

  return {
    command,
    port,
    host,
    noBrowser,
    dataDir,
    json,
    help,
    version,
    subcommandArgs,
    rawArgs: argv,
  };
}

/**
 * Main command dispatcher.
 * Routes subcommands to appropriate handlers or delegates to existing routines.
 */
export async function dispatch(
  argv: string[],
  options: DispatchOptions = {}
): Promise<CliCommandResult> {
  const writeOut = options.stdout || console.log;
  const writeErr = options.stderr || console.error;

  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err: any) {
    writeErr(`❌ Error: ${err.message}`);
    return { exitCode: 1, message: err.message };
  }

  if (parsed.help) {
    writeOut(HELP_TEXT.trim());
    return { exitCode: 0, message: "Help" };
  }

  if (parsed.version) {
    const rawVersion = getPackageVersion();
    const safeVersion = reconstructSemver(rawVersion) || rawVersion;
    writeOut(`khatamrouter v${safeVersion}`);
    return { exitCode: 0, message: safeVersion };
  }

  // Check for unknown leading subcommand
  if (
    parsed.rawArgs.length > 0 &&
    !parsed.rawArgs[0].startsWith("-") &&
    !KNOWN_SUBCOMMANDS.has(parsed.rawArgs[0])
  ) {
    const unknown = parsed.rawArgs[0];
    writeErr(`❌ Unknown command: "${unknown}". See --help for available commands.`);
    return { exitCode: 1, message: `Unknown command: ${unknown}` };
  }

  switch (parsed.command) {
    case "status": {
      return statusCommand({
        port: parsed.port,
        host: parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host,
        json: parsed.json,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    }

    case "ping": {
      return pingCommand({
        port: parsed.port,
        host: parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    }

    case "stop": {
      return stopCommand({
        port: parsed.port,
        host: parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    }

    case "show": {
      if (options.delegates?.show) {
        const code = await options.delegates.show(parsed.subcommandArgs);
        return { exitCode: code, message: "show executed" };
      }
      try {
        const show = require("../cli/commands/show");
        const code = await show.run(parsed.subcommandArgs);
        return { exitCode: code, message: "show executed" };
      } catch (err: any) {
        writeErr(`❌ Error running show: ${err.message}`);
        return { exitCode: 1, message: err.message };
      }
    }

    case "connect": {
      if (options.delegates?.connect) {
        const code = await options.delegates.connect(parsed.subcommandArgs);
        return { exitCode: code, message: "connect executed" };
      }
      try {
        const connect = require("../cli/commands/connect");
        const code = await connect.run(parsed.subcommandArgs);
        return { exitCode: code, message: "connect executed" };
      } catch (err: any) {
        writeErr(`❌ Error running connect: ${err.message}`);
        return { exitCode: 1, message: err.message };
      }
    }

    case "xai": {
      const xaiArgs = parsed.subcommandArgs[0] === "video"
        ? parsed.subcommandArgs.slice(1)
        : parsed.subcommandArgs;

      if (options.delegates?.xaiVideo) {
        const code = await options.delegates.xaiVideo(xaiArgs);
        return { exitCode: code, message: "xai video executed" };
      }
      try {
        const xai = require("../cli/commands/xaiVideo");
        const code = await xai.run(xaiArgs);
        return { exitCode: code, message: "xai video executed" };
      } catch (err: any) {
        writeErr(`❌ Error running xai video: ${err.message}`);
        return { exitCode: 1, message: err.message };
      }
    }

    case "start":
    default: {
      const serverOpts: CliServerOptions = {
        port: parsed.port,
        host: parsed.host,
        noBrowser: parsed.noBrowser,
        dataDir: parsed.dataDir,
      };

      if (options.delegates?.start) {
        const res = await options.delegates.start(serverOpts);
        const code = typeof res === "number" ? res : 0;
        return { exitCode: code, message: "start initiated", data: serverOpts };
      }

      return {
        exitCode: 0,
        message: "start options parsed",
        data: serverOpts,
      };
    }
  }
}
