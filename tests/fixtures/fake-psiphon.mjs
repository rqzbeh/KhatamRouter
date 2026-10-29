#!/usr/bin/env bun
import http from "node:http";
import fs from "node:fs";

// Parse CLI flags (-config <file>)
const args = process.argv.slice(2);
let configPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-config" && i + 1 < args.length) {
    configPath = args[i + 1];
    i++;
  }
}

if (!configPath || !fs.existsSync(configPath)) {
  process.stderr.write(`Error: missing or invalid config file: ${configPath}\n`);
  process.exit(1);
}

let config = {};
try {
  const content = fs.readFileSync(configPath, "utf-8");
  config = JSON.parse(content);
} catch (err) {
  process.stderr.write(`Error reading config JSON: ${err.message}\n`);
  process.exit(1);
}

const egressRegion = config.EgressRegion || "US";
const dataRootDir = config.DataRootDirectory || "/tmp";

// Env-driven fault injection
if (process.env.FAKE_PSIPHON_CRASH === "1" || process.env.FAKE_PSIPHON_CRASH === "true") {
  process.stderr.write("Simulated ConsoleClient crash\n");
  process.exit(1);
}

let latencyMap = {};
if (process.env.FAKE_PSIPHON_LATENCY_MAP) {
  try {
    latencyMap = JSON.parse(process.env.FAKE_PSIPHON_LATENCY_MAP);
  } catch {}
}

let availableRegions = ["US", "CA", "NL", "DE", "GB", "FR", "JP", "SG"];
if (process.env.FAKE_PSIPHON_AVAILABLE_REGIONS) {
  try {
    availableRegions = JSON.parse(process.env.FAKE_PSIPHON_AVAILABLE_REGIONS);
  } catch {}
}

function deriveIp(region, dir) {
  if (process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE && fs.existsSync(process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE)) {
    try {
      const content = fs.readFileSync(process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE, "utf-8").trim();
      const num = parseInt(content, 10);
      if (num > 0) {
        fs.writeFileSync(process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE, String(num - 1));
        return "198.51.100.99";
      }
    } catch {}
  }
  if (process.env.FAKE_PSIPHON_STATIC_IP) {
    return process.env.FAKE_PSIPHON_STATIC_IP;
  }
  // Deterministic fake IP from region + dir
  const str = `${region}:${dir}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const octet3 = ((Math.abs(hash) >> 8) % 250) + 1;
  const octet4 = (Math.abs(hash) % 250) + 1;
  return `198.51.${octet3}.${octet4}`;
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  const latency = latencyMap[egressRegion] || 0;

  const handle = () => {
    if (url.includes("generate_204")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.includes("ip") || url.includes("trace")) {
      const ip = deriveIp(egressRegion, dataRootDir);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(ip);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  };

  if (latency > 0) {
    setTimeout(handle, latency);
  } else {
    handle();
  }
});

// Support CONNECT for tunneling (undici ProxyAgent / https)
server.on("connect", (req, clientSocket, head) => {
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const handleChunk = (chunk) => {
    const text = chunk.toString();
    const latency = latencyMap[egressRegion] || 0;
    const respond = () => {
      if (text.includes("generate_204")) {
        clientSocket.write("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        clientSocket.end();
        return;
      }
      if (text.includes("ip") || text.includes("trace")) {
        const ip = deriveIp(egressRegion, dataRootDir);
        clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(ip)}\r\nConnection: close\r\n\r\n${ip}`);
        clientSocket.end();
        return;
      }
      clientSocket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
      clientSocket.end();
    };
    if (latency > 0) setTimeout(respond, latency);
    else respond();
  };
  if (head && head.length) handleChunk(head);
  clientSocket.on("data", handleChunk);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;

  if (process.env.FAKE_PSIPHON_NEVER_READY === "1" || process.env.FAKE_PSIPHON_NEVER_READY === "true") {
    // Hang without emitting readiness notices
    return;
  }

  if (process.env.FAKE_PSIPHON_FLOOD_STDOUT === "1" || process.env.FAKE_PSIPHON_FLOOD_STDOUT === "true") {
    try {
      fs.writeSync(1, Buffer.alloc(256 * 1024));
    } catch {}
  }

  const readyDelay = parseInt(process.env.FAKE_PSIPHON_READY_DELAY || "0", 10);

  const emitNotices = () => {
    // Non-JSON banner line to verify parser tolerance
    process.stderr.write("Psiphon ConsoleClient fake starting...\n");

    const notices = [
      { noticeType: "ListeningHttpProxyPort", data: { port } },
      { noticeType: "Tunnels", data: { count: 1 } },
      { noticeType: "ActiveTunnel", data: {} },
      { noticeType: "ConnectedServerRegion", data: { serverRegion: egressRegion } },
      { noticeType: "AvailableEgressRegions", data: { regions: availableRegions } },
    ];

    for (const n of notices) {
      process.stderr.write(JSON.stringify(n) + "\n");
    }

    if (process.env.FAKE_PSIPHON_CRASH_AFTER_READY === "1" || process.env.FAKE_PSIPHON_CRASH_AFTER_READY === "true") {
      setTimeout(() => {
        try {
          server.close();
        } catch {}
        process.exit(1);
      }, 150);
    }
  };

  if (readyDelay > 0) {
    setTimeout(emitNotices, readyDelay);
  } else {
    emitNotices();
  }
});

function shutdown() {
  try {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500);
  } catch {
    process.exit(0);
  }
}

if (process.env.FAKE_PSIPHON_IGNORE_SIGTERM === "1" || process.env.FAKE_PSIPHON_IGNORE_SIGTERM === "true") {
  process.on("SIGTERM", () => {
    // Intentionally ignore SIGTERM to test SIGKILL escalation
  });
} else {
  process.on("SIGTERM", shutdown);
}
process.on("SIGINT", shutdown);
