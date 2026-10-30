/**
 * SQLite binds TEXT as a NUL-terminated C string, so a bound string that
 * contains an embedded NUL cannot survive the round trip:
 *
 *  - better-sqlite3 rejects it outright: "TypeError: String contains null byte"
 *  - node:sqlite accepts it and silently keeps only the prefix before the NUL
 *  - bun:sqlite binds it cleanly, but stripping ensures consistent behavior across
 *    any boundary.
 *
 * Stripping the NUL bytes keeps the text readable and the write alive.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripNullBytes(value) {
  if (typeof value !== "string") return value;
  if (!value.includes("\0")) return value;
  return value.replace(/\0/g, "");
}
