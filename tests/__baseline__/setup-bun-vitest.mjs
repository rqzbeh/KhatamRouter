import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binVitest = path.resolve(__dirname, "../node_modules/.bin/vitest");
const targetMjs = path.resolve(__dirname, "../node_modules/vitest/vitest.mjs");

if (fs.existsSync(targetMjs)) {
  try { fs.unlinkSync(binVitest); } catch {}
  fs.writeFileSync(
    binVitest,
    `#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun --bun "$DIR/../vitest/vitest.mjs" "$@"
`
  );
  fs.chmodSync(binVitest, 0o755);
}
