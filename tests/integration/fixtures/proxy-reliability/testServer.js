import http from "node:http";
import https from "node:https";
import net from "node:net";
import forge from "node-forge";

/**
 * Creates a self-signed TLS test server for the given hostname.
 */
export async function createTestOriginServer({ hostname = "opencode.ai" } = {}) {
  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer([{ name: "commonName", value: hostname }]);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: hostname }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  const keyPem = pki.privateKeyToPem(keys.privateKey);

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
          error: { message: "rate limit exceeded", type: "FreeUsageLimitError" }
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
