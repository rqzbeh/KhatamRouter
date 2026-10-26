#!/usr/bin/env bun
/**
 * Seeding helper for Wave 8 Performance Ladder (T021).
 *
 * Configures an already-running gateway (host standalone or containerized behind LB)
 * to route requests for a mock prefix (e.g. "perf-mock/gpt-4o-mini") to the zero-latency
 * mock upstream server via the public HTTP dashboard and management API.
 *
 * Steps performed:
 * 1. Log in via POST /api/auth/login using INITIAL_PASSWORD.
 * 2. Check/create an openai-compatible provider node pointing at the mock upstream.
 * 3. Check/create an active provider connection for that node.
 * 4. Check/create an API key for running perf-ladder benchmarks.
 *
 * Usage:
 *   bun scripts/perf-ladder-seed.mjs [options]
 *
 * Options:
 *   --url <base>         Gateway base URL (default http://127.0.0.1:20128)
 *   --password <pwd>     Dashboard password (default $INITIAL_PASSWORD or 123456)
 *   --upstream <url>     Mock upstream baseUrl (default http://127.0.0.1:40128/v1)
 *   --prefix <prefix>    Provider prefix (default perf-mock)
 *   --key-name <name>    API key name (default perf-ladder-key)
 */

export async function seedGateway(options = {}) {
  const gatewayUrl = (options.url || process.env.GATEWAY_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
  const password = options.password || process.env.INITIAL_PASSWORD || "123456";
  const upstreamUrl = (options.upstream || process.env.MOCK_UPSTREAM_URL || "http://127.0.0.1:40128/v1").replace(/\/$/, "");
  const prefix = options.prefix || "perf-mock";
  const keyName = options.keyName || "perf-ladder-key";

  // Step 1: Login to get session cookie
  const loginRes = await fetch(`${gatewayUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Failed to log in to gateway at ${gatewayUrl}: HTTP ${loginRes.status} ${text}`);
  }

  // Extract set-cookie headers
  const setCookieHeader = loginRes.headers.get("set-cookie") || "";
  // In Bun / Node fetch, multiple cookies may be joined or accessed via getSetCookie()
  let cookieHeader = "";
  if (typeof loginRes.headers.getSetCookie === "function") {
    cookieHeader = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  } else if (setCookieHeader) {
    cookieHeader = setCookieHeader.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }

  const authHeaders = {
    "Content-Type": "application/json",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  // Step 2: Ensure provider node exists
  const nodesRes = await fetch(`${gatewayUrl}/api/provider-nodes`, { headers: authHeaders });
  if (!nodesRes.ok) {
    throw new Error(`Failed to list provider nodes: HTTP ${nodesRes.status}`);
  }
  const { nodes = [] } = await nodesRes.json();
  let node = nodes.find((n) => n.prefix === prefix);

  if (!node) {
    const createNodeRes = await fetch(`${gatewayUrl}/api/provider-nodes`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: prefix,
        prefix,
        type: "openai-compatible",
        apiType: "chat",
        baseUrl: upstreamUrl,
      }),
    });
    if (!createNodeRes.ok) {
      const errText = await createNodeRes.text();
      throw new Error(`Failed to create provider node: HTTP ${createNodeRes.status} ${errText}`);
    }
    const createNodeData = await createNodeRes.json();
    node = createNodeData.node || createNodeData;
  }

  const nodeId = node.id;

  // Step 3: Ensure provider connection exists
  const providersRes = await fetch(`${gatewayUrl}/api/providers`, { headers: authHeaders });
  if (!providersRes.ok) {
    throw new Error(`Failed to list provider connections: HTTP ${providersRes.status}`);
  }
  const { connections = [] } = await providersRes.json();
  let connection = connections.find((c) => c.provider === nodeId && c.isActive !== false);

  if (!connection) {
    const createConnRes = await fetch(`${gatewayUrl}/api/providers`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        provider: nodeId,
        name: `${prefix} mock connection`,
        apiKey: "sk-mock-perf-key",
      }),
    });
    if (!createConnRes.ok) {
      const errText = await createConnRes.text();
      throw new Error(`Failed to create provider connection: HTTP ${createConnRes.status} ${errText}`);
    }
    const createConnData = await createConnRes.json();
    connection = createConnData.connection || createConnData;
  }

  // Step 4: Ensure API key exists
  const keysRes = await fetch(`${gatewayUrl}/api/keys`, { headers: authHeaders });
  if (!keysRes.ok) {
    throw new Error(`Failed to list API keys: HTTP ${keysRes.status}`);
  }
  const { keys = [] } = await keysRes.json();
  let apiKeyRecord = keys.find((k) => k.name === keyName && k.isActive !== false);
  let apiKeyString = apiKeyRecord?.key;

  if (!apiKeyString) {
    const createKeyRes = await fetch(`${gatewayUrl}/api/keys`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: keyName }),
    });
    if (!createKeyRes.ok) {
      const errText = await createKeyRes.text();
      throw new Error(`Failed to create API key: HTTP ${createKeyRes.status} ${errText}`);
    }
    const createKeyData = await createKeyRes.json();
    apiKeyString = createKeyData.key;
  }

  return {
    gatewayUrl,
    nodeId,
    prefix,
    model: `${prefix}/gpt-4o-mini`,
    apiKey: apiKeyString,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) options.url = args[++i];
    else if (arg === "--password" && i + 1 < args.length) options.password = args[++i];
    else if (arg === "--upstream" && i + 1 < args.length) options.upstream = args[++i];
    else if (arg === "--prefix" && i + 1 < args.length) options.prefix = args[++i];
    else if (arg === "--key-name" && i + 1 < args.length) options.keyName = args[++i];
  }

  try {
    const result = await seedGateway(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[perf-ladder-seed] Error: ${err.message}`);
    process.exit(1);
  }
}
