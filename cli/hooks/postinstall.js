#!/usr/bin/env bun

// Postinstall: warm the tray runtime into ~/.9router/runtime. Failure here is
// non-fatal — cli.js self-heals it at runtime if anything is missing.
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[9router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
