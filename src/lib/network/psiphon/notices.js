/**
 * Psiphon ConsoleClient stderr notice parser.
 *
 * Notices are output as JSON lines on stderr: {"noticeType": "...", "data": ...}
 * Non-JSON lines (banners, logs, diagnostics) must be tolerated.
 */

/**
 * Attempt to parse a single line of stderr from Psiphon ConsoleClient.
 * @param {string} line - Raw text line
 * @returns {object|null} Notice object or null if line is not valid JSON
 */
export function parseNoticeLine(line) {
  if (!line || typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.noticeType === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts the listening HTTP proxy port if the notice is ListeningHttpProxyPort.
 * @param {object} notice
 * @returns {number|null}
 */
export function extractHttpProxyPort(notice) {
  if (notice?.noticeType === "ListeningHttpProxyPort") {
    const port = notice.data?.port ?? notice.data?.Port;
    const num = parseInt(port, 10);
    if (!Number.isNaN(num) && num > 0 && num < 65536) {
      return num;
    }
  }
  return null;
}

/**
 * Returns true if the notice indicates readiness of tunnels (Tunnels with count >= 1 or ActiveTunnel).
 * @param {object} notice
 * @returns {boolean}
 */
export function isTunnelReadyNotice(notice) {
  if (!notice) return false;
  if (notice.noticeType === "ActiveTunnel") return true;
  if (notice.noticeType === "Tunnels") {
    const count = notice.data?.count ?? notice.data?.Count;
    return typeof count === "number" && count >= 1;
  }
  return false;
}

/**
 * Extracts connected server region from ConnectedServerRegion notice.
 * @param {object} notice
 * @returns {string|null}
 */
export function extractConnectedRegion(notice) {
  if (notice?.noticeType === "ConnectedServerRegion") {
    const data = notice.data;
    if (typeof data === "string") return data.toUpperCase();
    if (typeof data?.serverRegion === "string") return data.serverRegion.toUpperCase();
    if (typeof data?.region === "string") return data.region.toUpperCase();
  }
  return null;
}

/**
 * Extracts available egress regions from AvailableEgressRegions notice.
 * @param {object} notice
 * @returns {string[]|null}
 */
export function extractAvailableRegions(notice) {
  if (notice?.noticeType === "AvailableEgressRegions") {
    const regions = notice.data?.regions || notice.data;
    if (Array.isArray(regions)) {
      return regions.filter((r) => typeof r === "string" && /^[A-Z]{2}$/i.test(r)).map((r) => r.toUpperCase());
    }
  }
  return null;
}

/**
 * Create a notice accumulator that handles chunked streams and tracks instance readiness.
 */
export function createNoticeAccumulator() {
  let buffer = "";
  let httpPort = null;
  let hasTunnel = false;
  let connectedRegion = null;
  let availableRegions = [];

  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Keep unfinished last line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const notice = parseNoticeLine(line);
        if (!notice) continue;

        const port = extractHttpProxyPort(notice);
        if (port !== null) httpPort = port;

        if (isTunnelReadyNotice(notice)) hasTunnel = true;

        const region = extractConnectedRegion(notice);
        if (region !== null) connectedRegion = region;

        const regions = extractAvailableRegions(notice);
        if (regions !== null && regions.length > 0) availableRegions = regions;
      }
    },
    flush() {
      if (buffer.trim()) {
        const notice = parseNoticeLine(buffer);
        if (notice) {
          const port = extractHttpProxyPort(notice);
          if (port !== null) httpPort = port;
          if (isTunnelReadyNotice(notice)) hasTunnel = true;
          const region = extractConnectedRegion(notice);
          if (region !== null) connectedRegion = region;
          const regions = extractAvailableRegions(notice);
          if (regions !== null && regions.length > 0) availableRegions = regions;
        }
        buffer = "";
      }
    },
    isReady() {
      return httpPort !== null && hasTunnel;
    },
    getPort() {
      return httpPort;
    },
    getRegion() {
      return connectedRegion;
    },
    getAvailableRegions() {
      return [...availableRegions];
    },
  };
}
