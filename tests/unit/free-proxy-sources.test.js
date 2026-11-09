// tests/unit/free-proxy-sources.test.js
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_FREE_PROXY_POLICY,
  KNOWN_SOURCES,
  MAX_FEED_BYTES,
  FREE_PROXY_FEED_URLS,
  ALLOWED_FEED_HOSTS,
  validatePolicyUpdate,
  validateCandidateProxy,
  computeFreePoolId,
  readBoundedStream,
  fetchFeedBounded,
  parseOneproxyFeed,
  parseProxiflyFeed,
  parseIplocateFeed,
  isPoolPrunable,
} from "../../src/lib/freeProxyProviders/index.js";

describe("Free Proxy Sources Core & Security Guards", () => {
  it("enforces MIT attribution and canonical OmniRoute permalink in all owned source files", () => {
    const rootDir = path.resolve(__dirname, "../../");
    const files = [
      "src/lib/freeProxyProviders/index.js",
      "src/app/api/settings/free-proxies/route.js",
      "src/app/api/settings/free-proxies/sync/route.js",
      "src/shared/components/FreeProxySourcesCard.js",
    ];

    for (const rel of files) {
      const full = path.join(rootDir, rel);
      expect(fs.existsSync(full)).toBe(true);
      const content = fs.readFileSync(full, "utf8");
      expect(content).toContain("cheaper-inference/OmniRoute");
      expect(content).toContain("2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac");
      expect(content).toContain("MIT License");
    }
  });

  it("provides default policy with all sources disabled and acknowledgedRisk: false", () => {
    expect(DEFAULT_FREE_PROXY_POLICY.acknowledgedRisk).toBe(false);
    expect(DEFAULT_FREE_PROXY_POLICY.enabled.oneproxy).toBe(false);
    expect(DEFAULT_FREE_PROXY_POLICY.enabled.proxifly).toBe(false);
    expect(DEFAULT_FREE_PROXY_POLICY.enabled.iplocate).toBe(false);
    expect(KNOWN_SOURCES).toEqual(["oneproxy", "proxifly", "iplocate"]);
  });

  it("rejects policy update enabling any source when risk is not acknowledged", () => {
    const result = validatePolicyUpdate(DEFAULT_FREE_PROXY_POLICY, {
      enabled: { oneproxy: true },
      acknowledgedRisk: false,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acknowledgedRisk"))).toBe(true);
  });

  it("rejects unknown source identifiers in policy update", () => {
    const result = validatePolicyUpdate(DEFAULT_FREE_PROXY_POLICY, {
      enabled: { webshare: true },
      acknowledgedRisk: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Unknown free proxy source"))).toBe(true);
  });

  it("accepts valid policy update when acknowledgedRisk is explicitly true", () => {
    const result = validatePolicyUpdate(DEFAULT_FREE_PROXY_POLICY, {
      enabled: { oneproxy: true, proxifly: false },
      acknowledgedRisk: true,
    });
    expect(result.valid).toBe(true);
    expect(result.policy.enabled.oneproxy).toBe(true);
    expect(result.policy.enabled.proxifly).toBe(false);
    expect(result.policy.acknowledgedRisk).toBe(true);
  });

  it("enforces late chunk cancellation when stream exceeds 2 MiB limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        // Enqueue 1 MiB chunks
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedStream(stream, MAX_FEED_BYTES)).rejects.toThrow(
      /streaming limit/i
    );
    expect(cancelled).toBe(true);
  });

  it("reads stream successfully when within max bytes limit", async () => {
    const data = "hello world from feed";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    });

    const output = await readBoundedStream(stream, MAX_FEED_BYTES);
    expect(output).toBe(data);
  });

  it("fetchFeedBounded rejects unallowed hostnames and non-https schemes", async () => {
    await expect(
      fetchFeedBounded("http://api.proxyscrape.com/test")
    ).rejects.toThrow(/must use HTTPS protocol/i);

    await expect(
      fetchFeedBounded("https://evil-untrusted-host.com/proxies")
    ).rejects.toThrow(/not in the allowed free proxy feed allowlist/i);
  });

  it("fetchFeedBounded rejects private IP and cloud metadata endpoints", async () => {
    await expect(
      fetchFeedBounded("https://127.0.0.1:8080/proxies")
    ).rejects.toThrow();

    await expect(
      fetchFeedBounded("https://169.254.169.254/proxies")
    ).rejects.toThrow();
  });

  it("fetchFeedBounded enforces maximum redirect limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        Location: "https://api.proxyscrape.com/redirect",
      }),
      ok: false,
    });

    await expect(
      fetchFeedBounded(
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=json",
        {
          customFetch: mockFetch,
          maxRedirects: 2,
        }
      )
    ).rejects.toThrow(/maximum of 2 redirects/i);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("candidate validator rejects non-IP hostnames to prevent DNS rebinding", async () => {
    const res = await validateCandidateProxy({
      host: "arbitrary-domain.com",
      port: 8080,
      protocol: "http",
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("not_ip_literal");
  });

  it("candidate validator rejects SOCKS protocols with explicit reason", async () => {
    const res = await validateCandidateProxy({
      host: "8.8.8.8",
      port: 1080,
      protocol: "socks5",
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("unsupported_socks_protocol");
  });

  it("candidate validator rejects private and cloud metadata IPs", async () => {
    const loopback = await validateCandidateProxy({
      host: "127.0.0.1",
      port: 8080,
      protocol: "http",
    });
    expect(loopback.valid).toBe(false);
    expect(loopback.reason).toBe("private_or_blocked_ip");

    const rfc1918 = await validateCandidateProxy({
      host: "192.168.1.1",
      port: 8080,
      protocol: "http",
    });
    expect(rfc1918.valid).toBe(false);
    expect(rfc1918.reason).toBe("private_or_blocked_ip");

    const metadata = await validateCandidateProxy({
      host: "169.254.169.254",
      port: 8080,
      protocol: "http",
    });
    expect(metadata.valid).toBe(false);
    expect(metadata.reason).toBe("private_or_blocked_ip");
  });

  it("candidate validator rejects invalid ports", async () => {
    const zeroPort = await validateCandidateProxy({
      host: "8.8.8.8",
      port: 0,
      protocol: "http",
    });
    expect(zeroPort.valid).toBe(false);
    expect(zeroPort.reason).toBe("invalid_port");

    const largePort = await validateCandidateProxy({
      host: "8.8.8.8",
      port: 70000,
      protocol: "http",
    });
    expect(largePort.valid).toBe(false);
    expect(largePort.reason).toBe("invalid_port");
  });

  it("candidate validator accepts valid public IPv4 address", async () => {
    const res = await validateCandidateProxy({
      host: "8.8.8.8",
      port: 8080,
      protocol: "http",
      countryCode: "us",
      latencyMs: 120,
      qualityScore: 95,
    });
    expect(res.valid).toBe(true);
    expect(res.candidate.host).toBe("8.8.8.8");
    expect(res.candidate.port).toBe(8080);
    expect(res.candidate.canonicalUrl).toBe("http://8.8.8.8:8080");
    expect(res.candidate.countryCode).toBe("US");
    expect(res.candidate.latencyMs).toBe(120);
    expect(res.candidate.qualityScore).toBe(95);
  });

  it("generates stable deterministic pool ID using Bun crypto hasher", () => {
    const url1 = "http://8.8.8.8:8080";
    const id1 = computeFreePoolId(url1);
    const id2 = computeFreePoolId(url1);
    expect(id1).toMatch(/^fp_[0-9a-f]{32}$/);
    expect(id1).toBe(id2);

    const url2 = "http://1.1.1.1:8080";
    const id3 = computeFreePoolId(url2);
    expect(id3).not.toBe(id1);
  });

  it("configures expected canonical feed URLs and allowed hosts", () => {
    expect(FREE_PROXY_FEED_URLS.oneproxy).toContain("api.proxyscrape.com");
    expect(FREE_PROXY_FEED_URLS.proxifly).toContain("cdn.jsdelivr.net");
    expect(FREE_PROXY_FEED_URLS.iplocate).toContain("raw.githubusercontent.com");

    expect(ALLOWED_FEED_HOSTS.has("api.proxyscrape.com")).toBe(true);
    expect(ALLOWED_FEED_HOSTS.has("cdn.jsdelivr.net")).toBe(true);
    expect(ALLOWED_FEED_HOSTS.has("raw.githubusercontent.com")).toBe(true);

    expect(ALLOWED_FEED_HOSTS.has("1proxy-api.aitradepulse.com")).toBe(false);
    expect(ALLOWED_FEED_HOSTS.has("api.proxifly.dev")).toBe(false);
  });

  it("parses oneproxy (ProxyScrape v4) feed correctly and skips alive:false entries", () => {
    const payload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "103.152.112.162",
          port: 80,
          protocol: "http",
          ip_data: { countryCode: "VN", city: "Hanoi" },
          timeout: 450,
          uptime: 85,
        },
        {
          alive: false,
          ip: "200.200.200.200",
          port: 8080,
          protocol: "http",
          ip_data: { countryCode: "BR" },
        },
        {
          alive: true,
          ip: "104.28.1.1",
          port: 3128,
          protocol: "http",
          country_code: "US", // fallback when ip_data is absent
          latency_ms: 60,
          quality_score: 92,
        },
      ],
    });

    const candidates = parseOneproxyFeed(payload);
    expect(candidates.length).toBe(2);

    expect(candidates[0].host).toBe("103.152.112.162");
    expect(candidates[0].port).toBe(80);
    expect(candidates[0].countryCode).toBe("VN");
    expect(candidates[0].latencyMs).toBe(450);
    expect(candidates[0].qualityScore).toBe(85);

    expect(candidates[1].host).toBe("104.28.1.1");
    expect(candidates[1].port).toBe(3128);
    expect(candidates[1].countryCode).toBe("US");
    expect(candidates[1].latencyMs).toBe(60);
    expect(candidates[1].qualityScore).toBe(92);
  });

  it("parses oneproxy, proxifly, and iplocate feeds correctly", () => {
    const oneproxyPayload = JSON.stringify({
      proxies: [
        {
          ip: "1.2.3.4",
          port: 8080,
          protocol: "http",
          country_code: "DE",
          latency_ms: 50,
          quality_score: 90,
        },
      ],
    });
    const opCandidates = parseOneproxyFeed(oneproxyPayload);
    expect(opCandidates.length).toBe(1);
    expect(opCandidates[0].host).toBe("1.2.3.4");
    expect(opCandidates[0].port).toBe(8080);
    expect(opCandidates[0].countryCode).toBe("DE");

    const proxiflyPayload = JSON.stringify([
      {
        ip: "5.6.7.8",
        port: 3128,
        protocol: "http",
        country: "FR",
        speed: 80,
        score: 75,
      },
    ]);
    const pfCandidates = parseProxiflyFeed(proxiflyPayload);
    expect(pfCandidates.length).toBe(1);
    expect(pfCandidates[0].host).toBe("5.6.7.8");
    expect(pfCandidates[0].port).toBe(3128);
    expect(pfCandidates[0].countryCode).toBe("FR");

    const iplocatePayload = `# Comment line\n9.10.11.12:8888\n\n13.14.15.16:9999\n`;
    const ipCandidates = parseIplocateFeed(iplocatePayload, "http");
    expect(ipCandidates.length).toBe(2);
    expect(ipCandidates[0].host).toBe("9.10.11.12");
    expect(ipCandidates[0].port).toBe(8888);
    expect(ipCandidates[1].host).toBe("13.14.15.16");
    expect(ipCandidates[1].port).toBe(9999);
  });

  it("isPoolPrunable accurately classifies dead free-owned pools", () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const freeUrl = "http://8.8.8.8:8080";
    const freeId = computeFreePoolId(freeUrl);

    // Eligible: inactive, error, older than 1h, free-owned with matching id
    const prunablePool = {
      id: freeId,
      proxyUrl: freeUrl,
      isActive: false,
      testStatus: "error",
      createdAt: twoHoursAgo,
      provenance: { source: "free:oneproxy" },
    };
    expect(isPoolPrunable(prunablePool, now)).toBe(true);

    // Ineligible: isActive is true
    expect(isPoolPrunable({ ...prunablePool, isActive: true }, now)).toBe(false);

    // Ineligible: testStatus is "ok" or not "error"
    expect(isPoolPrunable({ ...prunablePool, testStatus: "ok" }, now)).toBe(false);
    expect(isPoolPrunable({ ...prunablePool, testStatus: null }, now)).toBe(false);

    // Ineligible: newer than 1 hour
    expect(isPoolPrunable({ ...prunablePool, createdAt: tenMinutesAgo }, now)).toBe(false);

    // Ineligible: not free-owned provenance
    expect(
      isPoolPrunable(
        { ...prunablePool, provenance: { source: "manual" } },
        now
      )
    ).toBe(false);

    // Ineligible: id mismatch (custom id or manual override)
    expect(
      isPoolPrunable(
        { ...prunablePool, id: "custom_pool_id" },
        now
      )
    ).toBe(false);
  });
});
