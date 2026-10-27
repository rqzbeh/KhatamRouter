import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, "../..");

const {
  ipv6ToBigInt,
  parseTrustedProxyCidrs,
  isTrustedProxyPeer,
  resolveClientIp,
} = require(resolve(REPO_ROOT, "trusted-proxy.cjs"));

describe("parseTrustedProxyCidrs", () => {
  it("returns empty list when env var is unset, null, or empty string", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    expect(parseTrustedProxyCidrs(undefined, logError)).toEqual([]);
    expect(parseTrustedProxyCidrs(null, logError)).toEqual([]);
    expect(parseTrustedProxyCidrs("", logError)).toEqual([]);
    expect(errorLogs).toEqual([]);
  });

  it("parses valid IPv4 CIDRs with whitespace trimming", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    const parsed = parseTrustedProxyCidrs("172.18.0.0/16, 10.0.0.0/8", logError);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe(4);
    expect(parsed[1].type).toBe(4);
    expect(errorLogs).toEqual([]);
  });

  it("parses valid IPv6 CIDRs with correct prefix math", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    const parsed = parseTrustedProxyCidrs("fd00::/8, 2001:db8::/32", logError);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe(6);
    expect(parsed[1].type).toBe(6);
    expect(errorLogs).toEqual([]);
  });

  it("parses mixed IPv4 and IPv6 CIDRs", () => {
    const parsed = parseTrustedProxyCidrs("172.18.0.0/16, fd00::/8");
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe(4);
    expect(parsed[1].type).toBe(6);
  });

  it("logs and ignores invalid entries without widening trust", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    const input = [
      "not-a-cidr",          // garbage
      "localhost/24",        // hostname
      "example.com/16",      // hostname
      "10.0.0.0/33",         // IPv4 prefix > 32
      "fd00::/129",          // IPv6 prefix > 128
      "10.0.0.0/abc",        // non-numeric prefix
      "10.0.0.1",            // bare IP without prefix
      "",                    // empty segment
      "   ",                 // whitespace-only segment
      "172.18.0.0/16",       // valid entry
    ].join(", ");

    const parsed = parseTrustedProxyCidrs(input, logError);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].raw).toBe("172.18.0.0/16");
    expect(errorLogs.length).toBeGreaterThanOrEqual(8);
  });

  it("rejects and logs /0 entries for both IPv4 and IPv6", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    const parsed = parseTrustedProxyCidrs("0.0.0.0/0, ::/0, 10.0.0.0/0", logError);
    expect(parsed).toEqual([]);
    expect(errorLogs.some((l) => l.includes("Rejecting /0 CIDR"))).toBe(true);
  });
});

describe("isTrustedProxyPeer", () => {
  it("always trusts loopback peers when CIDRs are unset/empty", () => {
    const parsed = parseTrustedProxyCidrs(undefined);
    expect(isTrustedProxyPeer("127.0.0.1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("::1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("::FFFF:127.0.0.1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("[::1]", parsed)).toBe(true);
  });

  it("rejects non-loopback peers when CIDRs are unset/empty (master behavior)", () => {
    const parsed = parseTrustedProxyCidrs(undefined);
    expect(isTrustedProxyPeer("10.0.0.1", parsed)).toBe(false);
    expect(isTrustedProxyPeer("172.18.0.2", parsed)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.195", parsed)).toBe(false);
    expect(isTrustedProxyPeer("fe80::1", parsed)).toBe(false);
  });

  it("trusts peers matching configured IPv4 CIDRs", () => {
    const parsed = parseTrustedProxyCidrs("172.18.0.0/16, 10.0.0.0/8");
    expect(isTrustedProxyPeer("172.18.0.1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("172.18.254.254", parsed)).toBe(true);
    expect(isTrustedProxyPeer("10.1.2.3", parsed)).toBe(true);

    // Outside CIDRs
    expect(isTrustedProxyPeer("172.19.0.1", parsed)).toBe(false);
    expect(isTrustedProxyPeer("192.168.1.1", parsed)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.1", parsed)).toBe(false);
  });

  it("matches IPv4-mapped IPv6 peers (::ffff:a.b.c.d) to their IPv4 CIDR", () => {
    const parsed = parseTrustedProxyCidrs("172.18.0.0/16");
    expect(isTrustedProxyPeer("::ffff:172.18.0.2", parsed)).toBe(true);
    expect(isTrustedProxyPeer("::FFFF:172.18.10.5", parsed)).toBe(true);
    expect(isTrustedProxyPeer("::ffff:192.168.1.1", parsed)).toBe(false);
  });

  it("trusts peers matching configured IPv6 CIDRs with correct prefix math", () => {
    const parsed = parseTrustedProxyCidrs("fd00::/8, 2001:db8:abcd::/48");
    expect(isTrustedProxyPeer("fd00:1234::1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("fd12:3456:789a::1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("2001:db8:abcd:0001::1", parsed)).toBe(true);

    // Outside IPv6 CIDRs
    expect(isTrustedProxyPeer("fe80::1", parsed)).toBe(false);
    expect(isTrustedProxyPeer("2001:db8:abce::1", parsed)).toBe(false);
  });

  it("handles bracketed and malformed socket IPs safely", () => {
    const parsed = parseTrustedProxyCidrs("fd00::/8");
    expect(isTrustedProxyPeer("[fd00::1]", parsed)).toBe(true);
    expect(isTrustedProxyPeer("[fe80::1]", parsed)).toBe(false);
    expect(isTrustedProxyPeer("", parsed)).toBe(false);
    expect(isTrustedProxyPeer(null, parsed)).toBe(false);
    expect(isTrustedProxyPeer("invalid-ip", parsed)).toBe(false);
  });
});

describe("resolveClientIp & spoof protection", () => {
  const parsed = parseTrustedProxyCidrs("172.18.0.0/16");

  it("prevents spoofing from an untrusted peer outside CIDRs (spoof negative control)", () => {
    const untrustedSocketIp = "203.0.113.195";

    // Untrusted peer sends XFF
    const ipFromXff = resolveClientIp({
      socketIp: untrustedSocketIp,
      xff: "127.0.0.1",
      xRealIp: undefined,
      parsed,
    });
    expect(ipFromXff).toBe(untrustedSocketIp);

    // Untrusted peer sends X-Real-IP
    const ipFromRealIp = resolveClientIp({
      socketIp: untrustedSocketIp,
      xff: undefined,
      xRealIp: "127.0.0.1",
      parsed,
    });
    expect(ipFromRealIp).toBe(untrustedSocketIp);

    // Untrusted peer sends both
    const ipFromBoth = resolveClientIp({
      socketIp: untrustedSocketIp,
      xff: "10.0.0.1, 10.0.0.2",
      xRealIp: "127.0.0.1",
      parsed,
    });
    expect(ipFromBoth).toBe(untrustedSocketIp);
  });

  it("honours leftmost-XFF from a trusted proxy peer", () => {
    const trustedProxyIp = "172.18.0.2";
    const clientIp = resolveClientIp({
      socketIp: trustedProxyIp,
      xff: "198.51.100.22, 172.18.0.1",
      xRealIp: undefined,
      parsed,
    });
    expect(clientIp).toBe("198.51.100.22");
  });

  it("honours X-Real-IP from a trusted proxy peer", () => {
    const trustedProxyIp = "172.18.0.2";
    const clientIp = resolveClientIp({
      socketIp: trustedProxyIp,
      xff: undefined,
      xRealIp: "198.51.100.33",
      parsed,
    });
    expect(clientIp).toBe("198.51.100.33");
  });

  it("strips ports and brackets safely from forwarded headers", () => {
    const trustedProxyIp = "172.18.0.2";

    // IPv4 with port
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "198.51.100.22:8080, 172.18.0.1",
        parsed,
      })
    ).toBe("198.51.100.22");

    // IPv6 with port and brackets
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "[2001:db8::1]:443",
        parsed,
      })
    ).toBe("2001:db8::1");

    // IPv6 with brackets alone
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "[2001:db8::1]",
        parsed,
      })
    ).toBe("2001:db8::1");
  });

  it("falls back to socketIp when leftmost-XFF is syntactically invalid", () => {
    const trustedProxyIp = "172.18.0.2";

    // Malformed hostname in XFF
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "attacker-hostname, 10.0.0.1",
        parsed,
      })
    ).toBe(trustedProxyIp);

    // Garbage in XFF
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "not-an-ip",
        parsed,
      })
    ).toBe(trustedProxyIp);

    // Empty XFF
    expect(
      resolveClientIp({
        socketIp: trustedProxyIp,
        xff: "",
        parsed,
      })
    ).toBe(trustedProxyIp);
  });

  it("honours loopback proxy when CIDRs are unset (byte-identical to master)", () => {
    const unsetParsed = parseTrustedProxyCidrs(undefined);

    // Loopback peer with XFF
    expect(
      resolveClientIp({
        socketIp: "127.0.0.1",
        xff: "203.0.113.50",
        parsed: unsetParsed,
      })
    ).toBe("203.0.113.50");

    // Non-loopback peer with XFF is refused
    expect(
      resolveClientIp({
        socketIp: "172.18.0.2",
        xff: "203.0.113.50",
        parsed: unsetParsed,
      })
    ).toBe("172.18.0.2");
  });

  // Defect 5: Equivalence note test pinning stricter behavior than master
  it("deliberately stricter than master: loopback peer with non-IP XFF falls back to socketIp", () => {
    const unsetParsed = parseTrustedProxyCidrs(undefined);

    // Loopback peer + XFF 'unknown' => socketIp (127.0.0.1) instead of raw header
    expect(
      resolveClientIp({
        socketIp: "127.0.0.1",
        xff: "unknown",
        parsed: unsetParsed,
      })
    ).toBe("127.0.0.1");

    // Loopback peer + valid XFF => returns extracted XFF
    expect(
      resolveClientIp({
        socketIp: "127.0.0.1",
        xff: "203.0.113.195",
        parsed: unsetParsed,
      })
    ).toBe("203.0.113.195");
  });
});

describe("Defect 2: IPv6 zone IDs and non-throwing robustness", () => {
  it("strips %zone suffix in ipv6ToBigInt and does not throw RangeError", () => {
    expect(() => ipv6ToBigInt("fe80::%eth0")).not.toThrow();
    expect(() => ipv6ToBigInt("fe80::%1")).not.toThrow();
    expect(() => ipv6ToBigInt("::%eth0")).not.toThrow();
    expect(() => ipv6ToBigInt("fe80::1%eth0")).not.toThrow();
    expect(() => ipv6ToBigInt("[fe80::1%eth0]")).not.toThrow();
    expect(ipv6ToBigInt("fe80::1%eth0")).toBe(ipv6ToBigInt("fe80::1"));
    expect(ipv6ToBigInt("::%eth0")).toBe(0n);
  });

  it("handles zone-id peers with and without matching CIDR in isTrustedProxyPeer", () => {
    const parsed = parseTrustedProxyCidrs("fe80::/10, 172.18.0.0/16");

    // Matching IPv6 CIDR with zone id
    expect(isTrustedProxyPeer("fe80::1%eth0", parsed)).toBe(true);
    expect(isTrustedProxyPeer("fe80::%eth0", parsed)).toBe(true);
    expect(isTrustedProxyPeer("fe80::1%1", parsed)).toBe(true);
    expect(isTrustedProxyPeer("[fe80::1%eth0]", parsed)).toBe(true);

    // Non-matching peer with zone id
    const nonMatchingParsed = parseTrustedProxyCidrs("172.18.0.0/16");
    expect(isTrustedProxyPeer("fe80::1%eth0", nonMatchingParsed)).toBe(false);
    expect(isTrustedProxyPeer("fe80::%eth0", nonMatchingParsed)).toBe(false);
  });

  it("safely handles malformed IPv6 groups without throwing", () => {
    const malformed = [
      "fe80::1::2",
      "fe80:::1",
      "fe80::12345",
      "fe80::gggg",
      "fe80:1:2:3:4:5:6:7:8:9",
      "::1::",
      "1:2:3:4:5:6:7",
      "",
      null,
      undefined,
    ];

    const parsed = parseTrustedProxyCidrs("fe80::/10");
    for (const item of malformed) {
      expect(() => ipv6ToBigInt(item)).not.toThrow();
      expect(() => isTrustedProxyPeer(item, parsed)).not.toThrow();
      expect(isTrustedProxyPeer(item, parsed)).toBe(false);
    }
  });

  it("rejects CIDR strings with zone IDs without throwing", () => {
    const errorLogs = [];
    const logError = (msg) => errorLogs.push(msg);

    const parsed = parseTrustedProxyCidrs("fe80::%eth0/10, fe80::1%eth0/64, 10.0.0.0/8", logError);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].raw).toBe("10.0.0.0/8");
    expect(errorLogs.some((l) => l.includes("zone"))).toBe(true);
  });

  it("fuzz test: ~2000 random/hostile inputs assert resolveClientIp never throws and spoof protection holds", () => {
    const parsed = parseTrustedProxyCidrs("172.18.0.0/16, fd00::/8");
    const hostilePool = [
      "",
      "   ",
      null,
      undefined,
      "127.0.0.1",
      "::1",
      "172.18.0.1",
      "172.18.254.254",
      "172.19.0.1",
      "203.0.113.195",
      "fe80::%eth0",
      "fe80::%1",
      "::%eth0",
      "fe80::1%eth0",
      "[fe80::1%eth0]",
      "fe80::%eth0/10",
      "[fe80::1]:8080",
      "1.2.3.4:80",
      "0.0.0.0/0",
      "::/0",
      "not-an-ip",
      "attacker.com",
      "1.2.3.4.5",
      ":::",
      "::ffff:192.168.1.1",
      "::ffff:172.18.0.5",
      "fe80::1::2",
      "fe80::12345",
      "NaN",
      "Infinity",
      "-Infinity",
      "true",
      "false",
      "\x00\x01\x02",
      "\n\r\t",
      "0".repeat(500),
      "f".repeat(500),
      "127.0.0.1, 10.0.0.1",
      "unknown",
      "[::1]:443",
    ];

    for (let i = 0; i < 2000; i++) {
      const socketIp = hostilePool[i % hostilePool.length];
      const xff = hostilePool[(i * 3 + 1) % hostilePool.length];
      const xRealIp = hostilePool[(i * 7 + 2) % hostilePool.length];
      const envCidr = hostilePool[(i * 11 + 3) % hostilePool.length];

      expect(() => {
        const fuzzParsed = parseTrustedProxyCidrs(envCidr, () => {});
        const trusted = isTrustedProxyPeer(socketIp, fuzzParsed);
        const resolved = resolveClientIp({
          socketIp,
          xff,
          xRealIp,
          parsed,
        });

        // Spoof negative control invariant:
        // If peer is definitely untrusted (e.g., 203.0.113.195), resolved MUST equal socketIp
        if (socketIp === "203.0.113.195") {
          expect(trusted).toBe(false);
          expect(resolved).toBe("203.0.113.195");
        }
      }).not.toThrow();
    }
  });
});

describe("Defect 3: Elimination of NEGATIVE_CONTROL backdoor", () => {
  it("ensures the string 'NEGATIVE_CONTROL' does not appear in trusted-proxy.cjs", () => {
    const content = readFileSync(resolve(REPO_ROOT, "trusted-proxy.cjs"), "utf8");
    expect(content).not.toContain("NEGATIVE_CONTROL");
  });

  it("ensures setting TRUSTED_PROXY_NEGATIVE_CONTROL=1 has no effect on peer trust", () => {
    const prevEnv = process.env.TRUSTED_PROXY_NEGATIVE_CONTROL;
    try {
      process.env.TRUSTED_PROXY_NEGATIVE_CONTROL = "1";
      const parsed = parseTrustedProxyCidrs("172.18.0.0/16");
      // Untrusted peer MUST remain untrusted even when the env var is set
      expect(isTrustedProxyPeer("203.0.113.195", parsed)).toBe(false);
      expect(isTrustedProxyPeer("10.0.0.1", parsed)).toBe(false);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.TRUSTED_PROXY_NEGATIVE_CONTROL;
      } else {
        process.env.TRUSTED_PROXY_NEGATIVE_CONTROL = prevEnv;
      }
    }
  });
});
