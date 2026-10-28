import fs from "node:fs";
import crypto from "node:crypto";

// Publish `value` at `file` only if no other process has. Returns the value that won, so
// concurrent cold boots (multi-worker) converge on one secret instead of each keeping its own.
// Complete content is written to a temp file and hard-linked into place: link() fails with EEXIST
// for the loser, and the visible file is never half-written. Filesystems without hard links
// (some WSL/FAT mounts) fall back to an exclusive create.
export function publishSecretOnce(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return value;
  } catch (err) {
    if (err?.code !== "EEXIST") {
      try {
        fs.writeFileSync(file, value, { flag: "wx", mode: 0o600 });
        return value;
      } catch {
        // Lost the exclusive create too; the winner is read below.
      }
    }
    return fs.readFileSync(file, "utf8").trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
