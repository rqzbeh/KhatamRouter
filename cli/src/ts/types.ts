/**
 * CLI Consolidated Types Data Model
 * Wave 8 — Dashboard & Tooling (contracts/cli-contract.md & data-model.md)
 */

export interface CliServerOptions {
  port: number;
  host: string;
  noBrowser: boolean;
  dataDir?: string;
}

export interface CliRuntimeStatus {
  online: boolean;
  pid?: number;
  port: number;
  host: string;
  uptimeSeconds?: number;
  version: string;
  bunVersion?: string;
  activeConnectionsCount?: number;
  redisConnected?: boolean;
}

export type CliCommandName =
  | "start"
  | "status"
  | "ping"
  | "stop"
  | "show"
  | "connect"
  | "xai";

export interface ParsedCliArgs {
  command: CliCommandName;
  port: number;
  host: string;
  noBrowser: boolean;
  dataDir?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  subcommandArgs: string[];
  rawArgs: string[];
}

export interface CliCommandResult<T = unknown> {
  exitCode: number;
  message?: string;
  data?: T;
}

export interface StatusCommandOptions {
  port?: number;
  host?: string;
  json?: boolean;
  timeoutMs?: number;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface PingCommandOptions {
  port?: number;
  host?: string;
  timeoutMs?: number;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface PingResult {
  tcp: boolean;
  http: boolean;
  latencyMs: number;
}

export interface StopCommandOptions {
  port?: number;
  host?: string;
  timeoutMs?: number;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface StopResult {
  success: boolean;
  message: string;
}

export interface BunPrerequisiteCheckOptions {
  findBun?: () => string | null;
  stderr?: (msg: string) => void;
  exit?: (code: number) => void;
}

export interface CliDelegates {
  start?: (options: CliServerOptions) => Promise<number | void>;
  show?: (args: string[]) => Promise<number>;
  connect?: (args: string[]) => Promise<number>;
  xaiVideo?: (args: string[]) => Promise<number>;
}

export interface DispatchOptions {
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  delegates?: CliDelegates;
  ensureBunCheck?: boolean;
}
