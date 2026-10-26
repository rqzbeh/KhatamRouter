// Strict semver validation and comparison
// Constraints:
// - Strings only, length <= 64
// - Refuse any control characters (0x00-0x1F, 0x7F)
// - Strictly anchored semver: optional leading 'v', 1-9 digits per part, optional prerelease/build [0-9A-Za-z.-]
// - Reconstructs version string strictly from parsed safe integers

const SEMVER_STRICT_REGEX = /^v?([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(v) {
  if (!v || typeof v !== "string" || v.length > 64) return null;
  if (/[\x00-\x1F\x7F]/.test(v)) return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  const match = trimmed.match(SEMVER_STRICT_REGEX);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

function reconstructSemver(v) {
  const parts = parseSemver(v);
  if (!parts) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

module.exports = {
  parseSemver,
  reconstructSemver,
  compareVersions,
};
