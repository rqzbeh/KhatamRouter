/**
 * Helper to strip cookie prefixes (e.g. "sso=xyz" -> "xyz")
 * @param {string} rawCookie - The raw cookie value from credentials
 * @param {string} key - The cookie name key (e.g. "sso", "ecto_1_sess")
 * @returns {string} Cleaned cookie token value
 */
export function cleanCookie(rawCookie, key) {
  if (!rawCookie) return "";
  let token = rawCookie.trim();
  const prefix = `${key}=`;
  if (token.startsWith(prefix)) {
    token = token.slice(prefix.length).trim();
  }
  return token;
}
