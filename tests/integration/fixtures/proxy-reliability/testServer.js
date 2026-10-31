import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import forge from "node-forge";

/**
 * Native C-level setenv helper for Bun to ensure C/Rust getenv("SSL_CERT_FILE")
 * sees the configured CA file at runtime.
 */
function setNativeEnv(name, value) {
  process.env[name] = value;
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    const libc = dlopen("libc.so.6", {
      setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    });
    libc.symbols.setenv(Buffer.from(name + "\0"), Buffer.from(value + "\0"), 1);
  } catch {}
}

/**
 * Creates an ephemeral trusted Root CA with standard RFC5280 extensions.
 * Exports the CA cert to a temporary file and sets native SSL_CERT_FILE.
 */
export async function createEphemeralCA() {
  const pki = forge.pki;
  const caKeys = pki.rsa.generateKeyPair(2048);
  const caCert = pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date(Date.now() - 3600000);
  caCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
  const caAttrs = [{ name: "commonName", value: "Ephemeral Test Root CA" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const caCertPem = pki.certificateToPem(caCert);
  const caKeyPem = pki.privateKeyToPem(caKeys.privateKey);

  const caPath = path.join(os.tmpdir(), `test-ephemeral-ca-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
  fs.writeFileSync(caPath, caCertPem);

  // Set native SSL_CERT_FILE so wreq-js / BoringSSL uses this CA
  setNativeEnv("SSL_CERT_FILE", caPath);

  return {
    caCert,
    caKey: caKeys.privateKey,
    caCertPem,
    caKeyPem,
    caPath,
    cleanup: () => {
      try { fs.unlinkSync(caPath); } catch {}
    },
  };
}

/**
 * Creates a TLS test server for the given hostname, signed by the provided CA (or a fresh ephemeral CA).
 */
export async function createTestOriginServer({ hostname = "opencode.ai", caCert, caKey, onRequest } = {}) {
  const pki = forge.pki;
  let currentOnRequest = onRequest;

  let signingCert = caCert;
  let signingKey = caKey;
  let caCleanup = null;

  if (!signingCert || !signingKey) {
    const ca = await createEphemeralCA();
    signingCert = ca.caCert;
    signingKey = ca.caKey;
    caCleanup = ca.cleanup;
  }

  const serverKeys = pki.rsa.generateKeyPair(2048);
  const serverCert = pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = String(Date.now());
  serverCert.validity.notBefore = new Date(Date.now() - 3600000);
  serverCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
  serverCert.setSubject([{ name: "commonName", value: hostname }]);
  serverCert.setIssuer(signingCert.subject.attributes);
  serverCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
  ]);
  serverCert.sign(signingKey, forge.md.sha256.create());

  const certPem = pki.certificateToPem(serverCert);
  const keyPem = pki.privateKeyToPem(serverKeys.privateKey);

  let directConnectionsCount = 0;
  let requestsCount = 0;
  const requests = [];

  const server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    requestsCount++;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (typeof currentOnRequest === "function") {
        const handled = currentOnRequest(req, res, { body, url: req.url, method: req.method, headers: req.headers });
        if (handled !== false) return;
      }

      if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: chunk-1\n\n");
        setTimeout(() => {
          res.write("data: chunk-2\n\n");
          res.end();
        }, 50);
        return;
      }

      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://attacker.example/off-host" });
        res.end();
        return;
      }

      if (req.url === "/slow") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // Never ends to test abort
        return;
      }

      if (req.url === "/quota-429") {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "45",
        });
        res.end(JSON.stringify({
          error: { message: "rate limit exceeded", type: "FreeUsageLimitError" },
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
  });

  server.on("connection", () => {
    directConnectionsCount++;
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    server,
    port,
    hostname,
    certPem,
    keyPem,
    getDirectConnectionsCount: () => directConnectionsCount,
    getRequestsCount: () => requestsCount,
    getRequests: () => requests,
    setOnRequest: (fn) => { currentOnRequest = fn; },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (caCleanup) caCleanup();
    },
  };
}

/**
 * Creates an untrusted TLS test server with a self-signed cert not in the trust store.
 */
export async function createUntrustedOriginServer({ hostname = "opencode.ai" } = {}) {
  const pki = forge.pki;
  const untrustedKeys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = untrustedKeys.publicKey;
  cert.serialNumber = "99";
  cert.validity.notBefore = new Date(Date.now() - 3600000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer([{ name: "commonName", value: "Untrusted Rogue CA" }]);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: hostname }] }]);
  cert.sign(untrustedKeys.privateKey, forge.md.sha256.create());

  const certPem = pki.certificateToPem(cert);
  const keyPem = pki.privateKeyToPem(untrustedKeys.privateKey);

  const server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    server,
    port,
    hostname,
    certPem,
    keyPem,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Creates a local HTTP CONNECT proxy server that routes CONNECT requests for targetHostname
 * to the specified local origin port.
 */
export async function createTestConnectProxy({ targetPort, targetHostname = "opencode.ai" } = {}) {
  let connectCount = 0;
  let activeConnections = 0;
  let shouldRefuse = false;
  const activeSockets = new Set();

  const proxy = http.createServer((req, res) => {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed: use CONNECT for HTTPS proxy");
  });

  proxy.on("connect", (req, clientSocket, head) => {
    connectCount++;
    if (shouldRefuse) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\nProxy Refused");
      clientSocket.destroy();
      return;
    }

    activeSockets.add(clientSocket);
    activeConnections++;
    const srvSocket = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) srvSocket.write(head);
      srvSocket.pipe(clientSocket);
      clientSocket.pipe(srvSocket);
    });

    const cleanup = () => {
      activeSockets.delete(clientSocket);
      activeConnections = Math.max(0, activeConnections - 1);
    };
    srvSocket.on("close", cleanup);
    clientSocket.on("close", cleanup);

    srvSocket.on("error", () => {
      cleanup();
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      cleanup();
      srvSocket.destroy();
    });
  });

  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = proxy.address().port;

  return {
    proxy,
    port,
    url: `http://127.0.0.1:${port}`,
    getConnectCount: () => connectCount,
    getActiveConnections: () => activeConnections,
    setRefuse: (val) => {
      shouldRefuse = val;
      if (val) {
        for (const sock of activeSockets) {
          sock.destroy();
        }
        activeSockets.clear();
      }
    },
    close: () => new Promise((resolve) => proxy.close(resolve)),
  };
}
