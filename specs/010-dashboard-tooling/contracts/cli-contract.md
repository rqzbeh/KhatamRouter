# CLI Command Contract: Standalone Plain JavaScript CLI

**Package**: `cli/` (`9router` on npm)  
**Binary Entrypoint**: `./cli.js` (plain JavaScript launcher)  

---

## Command Matrix

| Command | Arguments / Flags | Description | Offline / Online | Key Masking |
|---|---|---|---|---|
| `9router` (default) | `[--port <N>] [--host <H>] [--no-browser]` | Spawns Bun gateway, waits for TCP readiness, launches browser | Online (local) | N/A |
| `9router show` | `[toolId]` | Reads local configs for agent CLI tools (Claude, OpenCode, Codex, etc.) | Offline | Always masked (`sk-abc...1234`) |
| `9router connect` | `<gatewayUrl> [--key <K>]` | Configures local CLI tools against a target gateway | Offline | Masked |
| `9router status` | `[--port <N>] [--json]` | Queries local gateway `/api/health` and displays PID, port, uptime | Online (local) | N/A |
| `9router ping` | `[--port <N>]` | Verifies TCP and HTTP ping to local gateway | Online (local) | N/A |
| `9router stop` | `[--port <N>]` | Gracefully shuts down running gateway instance via `/api/shutdown` | Online (local) | N/A |
| `9router xai video` | `[subcommand args]` | CLI video generation subcommand | Online (remote) | N/A |

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
