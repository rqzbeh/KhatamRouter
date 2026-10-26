# CLI Command Contract: Standalone Plain JavaScript CLI

The published CLI (`cli/cli.js`, published as `9router`) is unchanged. The proposed TypeScript CLI rewrite and new subcommands (`status`, `ping`, `stop`) were DROPPED per Principle II (plain JavaScript ESM, PR #64).

**Package**: `cli/` (`9router` on npm)  
**Binary Entrypoint**: `./cli.js` (plain JavaScript launcher)  

---

## Command Matrix

| Command | Arguments / Flags | Description | Status | Key Masking |
|---|---|---|---|---|
| `9router` (default) | `[--port <N>] [--host <H>] [--no-browser]` | Spawns Bun gateway, waits for TCP readiness, launches browser | Active | N/A |
| `9router show` | `[toolId]` | Reads local configs for agent CLI tools (Claude, OpenCode, Codex, etc.) | Active | Always masked (`sk-abc...1234`) |
| `9router connect` | `<gatewayUrl> [--key <K>]` | Configures local CLI tools against a target gateway | Active | Masked |
| `9router xai video` | `[subcommand args]` | CLI video generation subcommand | Active | N/A |
| `9router status` | `[--port <N>] [--json]` | Proposed health inspection subcommand | DROPPED (TS CLI dropped) | N/A |
| `9router ping` | `[--port <N>]` | Proposed gateway ping subcommand | DROPPED (TS CLI dropped) | N/A |
| `9router stop` | `[--port <N>]` | Proposed gateway shutdown subcommand | DROPPED (TS CLI dropped) | N/A |

---

## Runtime Prerequisite Check Contract

When `findBunExecutable()` returns null, execution immediately aborts before spawning any server or importing Bun modules:
- Exit code: `1`
- Error message contains:
  ```text
  Error: Bun runtime is required to run 9Router.
  Starting with Wave 7.5, 9Router runs exclusively on Bun (bun:sqlite)
  and no longer supports Node-only execution.
  Please install Bun from https://bun.sh:
    curl -fsSL https://bun.sh/install | bash
  ```
