import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(__dirname, "../../");

// Custom YAML schema to handle Docker Compose v2 !reset tag
const resetScalar = new yaml.Type("!reset", {
  kind: "scalar",
  construct: (data) => data,
});
const resetSeq = new yaml.Type("!reset", {
  kind: "sequence",
  construct: (data) => data,
});
const COMPOSE_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([resetScalar, resetSeq]);

function loadScaleOverlay() {
  const overlayPath = path.join(REPO_ROOT, "docker-compose.scale.yml");
  const raw = fs.readFileSync(overlayPath, "utf8");
  return { raw, parsed: yaml.load(raw, { schema: COMPOSE_YAML_SCHEMA }) };
}

function loadNginxConf() {
  const confPath = path.join(REPO_ROOT, "deploy/nginx-scale.conf");
  return fs.readFileSync(confPath, "utf8");
}

function loadSmokeScript() {
  const scriptPath = path.join(REPO_ROOT, "scripts/scale-smoke.sh");
  return fs.readFileSync(scriptPath, "utf8");
}

describe("Wave 8: Multi-Replica Scale Compose & Trusted Proxy Contract (T017, T018)", () => {
  describe("docker-compose.scale.yml overlay", () => {
    it("exists and is valid YAML", () => {
      const { parsed } = loadScaleOverlay();
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
      expect(parsed.services).toBeDefined();
    });

    it("does not set a fixed container_name on 9router", () => {
      const { raw, parsed } = loadScaleOverlay();
      // Regex check: never set a fixed container_name: 9router
      expect(raw).not.toMatch(/container_name:\s*9router\s*$/m);
      const app = parsed.services?.["9router"];
      expect(app).toBeDefined();
      // Either container_name is null, !reset null, or undefined
      if (app.container_name !== undefined) {
        expect(app.container_name === null || app.container_name === "null" || app.container_name === "").toBe(true);
      }
    });

    it("does not publish host ports on 9router (LB alone publishes 20128)", () => {
      const { parsed } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      expect(app).toBeDefined();
      // ports is either reset to empty array, null, or undefined
      if (app.ports) {
        expect(Array.isArray(app.ports)).toBe(true);
        expect(app.ports.length).toBe(0);
      }
    });

    it("defines healthcheck targeting /api/health with start_period", () => {
      const { parsed, raw } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      expect(app.healthcheck).toBeDefined();
      const testCmd = Array.isArray(app.healthcheck.test)
        ? app.healthcheck.test.join(" ")
        : String(app.healthcheck.test);
      expect(testCmd).toContain("curl");
      expect(testCmd).toContain("/api/health");
      expect(app.healthcheck.start_period).toBeDefined();
      expect(raw).toContain("/api/health");
    });

    it("shares 9router-data named volume and DATA_DIR with base compose", () => {
      const { parsed } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      expect(app.volumes).toBeDefined();
      const hasVol = app.volumes.some((v) => String(v).includes("9router-data:/app/data"));
      expect(hasVol).toBe(true);
      expect(parsed.volumes?.["9router-data"]).toBeDefined();
      expect(app.environment?.DATA_DIR).toBe("/app/data");
    });

    it("wires REDIS_URL to redis service", () => {
      const { parsed } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      expect(app.environment?.REDIS_URL).toBe("redis://redis:6379");
    });

    it("configures deterministic subnet in IPAM and sets TRUSTED_PROXY_CIDRS to only the LB /32 address", () => {
      const { parsed } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      const cidr = app.environment?.TRUSTED_PROXY_CIDRS;
      expect(cidr).toBeDefined();

      // LB must have fixed ipv4_address
      const lb = parsed.services?.lb;
      expect(lb).toBeDefined();
      const lbIp = lb.networks?.default?.ipv4_address;
      expect(lbIp).toBeDefined();

      // TRUSTED_PROXY_CIDRS must be single address as /32 (never the whole /24)
      expect(cidr).toBe(`${lbIp}/32`);
      expect(cidr).not.toBe("172.31.250.0/24");

      // Verify deterministic IPAM network configuration
      const net = parsed.networks?.default;
      expect(net).toBeDefined();
      expect(net.ipam?.config).toBeDefined();
      const subnetConfig = net.ipam.config.find((c) => c.subnet === "172.31.250.0/24");
      expect(subnetConfig).toBeDefined();

      // Verify lbIp is within the 172.31.250.0/24 subnet
      expect(lbIp.startsWith("172.31.250.")).toBe(true);

      // Verify ip_range is configured so dynamic allocation cannot collide with static lbIp
      expect(subnetConfig.ip_range).toBeDefined();

      // Verify IPv6 is explicitly disabled on the compose bridge network
      expect(net.enable_ipv6).toBe(false);
    });

    it("requires runtime secrets via ${VAR:?...} and commits no literal secrets", () => {
      const { raw, parsed } = loadScaleOverlay();
      const app = parsed.services?.["9router"];
      const env = app.environment || {};

      expect(String(env.JWT_SECRET)).toContain("${JWT_SECRET:?");
      expect(String(env.API_KEY_SECRET)).toContain("${API_KEY_SECRET:?");
      expect(String(env.INITIAL_PASSWORD)).toContain("${INITIAL_PASSWORD:?");
      expect(String(env.MACHINE_ID_SALT)).toContain("${MACHINE_ID_SALT:?");

      // Security invariant: raw YAML must not contain plaintext committed secrets
      expect(raw).not.toContain("password123");
      expect(raw).not.toContain("change-me-to-a-long-random-secret");
    });

    it("configures lb service with nginx:alpine publishing SCALE_SMOKE_LB_PORT and depending on 9router health", () => {
      const { parsed } = loadScaleOverlay();
      const lb = parsed.services?.lb;
      expect(lb).toBeDefined();
      expect(lb.image).toMatch(/^nginx/);
      expect(lb.ports).toBeDefined();
      expect(lb.ports.some((p) => String(p).includes("${SCALE_SMOKE_LB_PORT:-20128}:20128"))).toBe(true);

      // Mounts nginx-scale.conf
      expect(lb.volumes).toBeDefined();
      expect(lb.volumes.some((v) => String(v).includes("nginx-scale.conf"))).toBe(true);

      // Depends on healthy 9router
      expect(lb.depends_on?.["9router"]).toBeDefined();
      expect(lb.depends_on["9router"].condition).toBe("service_healthy");
    });

    it("never contains prune commands", () => {
      const { raw } = loadScaleOverlay();
      expect(raw).not.toMatch(/prune/i);
    });
  });

  describe("deploy/nginx-scale.conf load balancer configuration", () => {
    it("exists and defines dynamic upstream resolution with ipv6=off to 9router:20128", () => {
      const conf = loadNginxConf();
      expect(conf).toMatch(/resolver\s+127\.0\.0\.11\s+valid=5s\s+ipv6=off\s*;/);
      expect(conf).toMatch(/set\s+\$khatam_upstream\s+http:\/\/9router:20128\s*;/);
      expect(conf).toMatch(/proxy_pass\s+\$khatam_upstream\s*;/);
      expect(conf).toMatch(/listen\s+20128/);
    });

    it("overwrites X-Forwarded-For with $remote_addr (never appends via proxy_add_x_forwarded_for)", () => {
      const conf = loadNginxConf();
      // Security requirement: MUST overwrite XFF with $remote_addr
      expect(conf).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/);
      expect(conf).toMatch(/proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/);
      // Security invariant: NEVER use proxy_add_x_forwarded_for
      expect(conf).not.toContain("proxy_add_x_forwarded_for");
    });

    it("configures SSE streaming: proxy_buffering off and long read timeout", () => {
      const conf = loadNginxConf();
      expect(conf).toMatch(/proxy_buffering\s+off\s*;/);
      expect(conf).toMatch(/proxy_read_timeout\s+[0-9]+s?\s*;/);
      // Timeout should be at least 300s (5m) for long SSE inference responses
      const match = conf.match(/proxy_read_timeout\s+([0-9]+)s?\s*;/);
      if (match) {
        expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(300);
      }
    });

    it("configures HTTP/1.1 and documents variable proxy_pass keepalive behavior", () => {
      const conf = loadNginxConf();
      expect(conf).toMatch(/proxy_http_version\s+1\.1\s*;/);
      expect(conf).toMatch(/proxy_set_header\s+Connection\s+""\s*;/);
      expect(conf).toMatch(/keepalive/i);
    });

    it("never contains prune commands", () => {
      const conf = loadNginxConf();
      expect(conf).not.toMatch(/prune/i);
    });
  });

  describe(".env.example documentation", () => {
    const envPath = path.join(REPO_ROOT, ".env.example");
    const envContent = fs.readFileSync(envPath, "utf8");

    it("documents TRUSTED_PROXY_CIDRS as commented and default empty", () => {
      expect(envContent).toContain("TRUSTED_PROXY_CIDRS=");
      // Must be commented out by default
      expect(envContent).toMatch(/^#\s*TRUSTED_PROXY_CIDRS=/m);
    });

    it("includes security warning that proxy must be controlled and overwrite XFF", () => {
      expect(envContent).toMatch(/SECURITY WARNING|security warning/i);
      expect(envContent).toContain("OVERWRITE");
      expect(envContent).toMatch(/loopback/i);
    });
  });

  describe("DOCKER.md documentation", () => {
    const dockerMdPath = path.join(REPO_ROOT, "DOCKER.md");
    const dockerMdContent = fs.readFileSync(dockerMdPath, "utf8");

    it("documents multi-replica scaling command using overlay", () => {
      expect(dockerMdContent).toContain("docker-compose.scale.yml");
      expect(dockerMdContent).toMatch(/--scale\s+9router=/);
    });

    it("includes single-host-only limitation note for SQLite WAL (NFS/EFS unsupported)", () => {
      expect(dockerMdContent).toMatch(/single-host only|single host only/i);
      expect(dockerMdContent).toMatch(/NFS|EFS/);
      expect(dockerMdContent).toMatch(/unsupported/i);
      expect(dockerMdContent).toMatch(/WAL/);
    });
  });

  describe("scripts/scale-smoke.sh smoke drill script", () => {
    it("exists and has valid shebang and strict mode", () => {
      const script = loadSmokeScript();
      expect(script).toMatch(/^#!.*\b(bash|sh)\b/);
      expect(script).toContain("set -euo pipefail");
    });

    it("passes syntax check with bash -n", () => {
      const scriptPath = path.join(REPO_ROOT, "scripts/scale-smoke.sh");
      const result = execFileSync("bash", ["-n", scriptPath], { encoding: "utf8" });
      expect(result).toBe("");
    });

    it("uses isolated project khatam-scale-smoke and cleans up with down -v", () => {
      const script = loadSmokeScript();
      expect(script).toContain("khatam-scale-smoke");
      expect(script).toMatch(/docker\s+compose.*down\s+-v/);
    });

    it("never contains prune commands (forbidden)", () => {
      const script = loadSmokeScript();
      expect(script).not.toMatch(/docker\s+(system\s+)?prune/);
      expect(script).not.toMatch(/volume\s+prune/);
    });

    it("takes N replicas argument and exercises --scale 9router=N", () => {
      const script = loadSmokeScript();
      expect(script).toMatch(/--scale\s+9router=/);
    });

    it("covers all required smoke drills", () => {
      const script = loadSmokeScript();
      // Healthcheck / LB readiness
      expect(script).toMatch(/health|ready/i);
      // Cross-replica circuit breaker trip
      expect(script).toMatch(/circuit|trip|breaker/i);
      // Single-use token refresh mutex
      expect(script).toMatch(/refresh/i);
      // Cross-replica rotation
      expect(script).toMatch(/rotation/i);
      // Redis outage drill (stopping redis, verifying 2xx and single warning)
      expect(script).toMatch(/redis/i);
      // Spoof control test
      expect(script).toMatch(/spoof|X-Forwarded-For/i);
    });

    it("never uses docker compose exec with container ID variables (must use docker exec)", () => {
      const script = loadSmokeScript();
      // compose exec expects a service name, not a hex container ID.
      // Commands targeting replica containers like $REPLICA_A or $CID must use docker exec.
      expect(script).not.toMatch(/docker\s+compose\b.*exec\s+(-[a-zA-Z]+\s+)*\$REPLICA/);
      expect(script).not.toMatch(/docker\s+compose\b.*exec\s+(-[a-zA-Z]+\s+)*\$CID\b/);
    });

    it("never uses pass-defaulting fallback patterns like || echo '200' or || echo '401'", () => {
      const script = loadSmokeScript();
      expect(script).not.toMatch(/\|\|\s*echo\s*["']200["']/);
      expect(script).not.toMatch(/\|\|\s*echo\s*["']401["']/);
    });

    it("prints final summary tally with PASS, FAIL, and SKIPPED counts", () => {
      const script = loadSmokeScript();
      expect(script).toMatch(/Summary:.*PASSED.*FAILED.*SKIPPED/i);
      expect(script).toContain("SCALE_SMOKE_OK");
    });

    it("observes real client IP and asserts absence of forged IP in spoof controls via Redis", () => {
      const script = loadSmokeScript();
      expect(script).toMatch(/khatam:ratelimit:login:/);
      expect(script).toMatch(/FORGED_MARKER/);
      expect(script).toMatch(/redis-cli\s+EXISTS/);
    });
  });
});
