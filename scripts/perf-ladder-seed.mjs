#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { assertDataDirAllowed } from "./perf-ladder-lib.mjs";

export async function seedViaDatabase({
  dataDir,
  upstreamUrl = "http://127.0.0.1:40128/v1",
  prefix = "perf-mock",
  model = "gpt-4o-mini",
  comboName = "perf-combo",
  keyName = "perf-ladder-key",
  apiKey = "sk-mock-perf-key",
}) {
  assertDataDirAllowed(dataDir);
  process.env.DATA_DIR = dataDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";

  const db = await import("../src/lib/db/index.js");
  const nodeId = `openai-compatible-chat-${prefix}`;

  await db.createProviderNode({
    id: nodeId,
    type: "openai-compatible",
    name: `${prefix} node`,
    prefix,
    apiType: "chat",
    baseUrl: upstreamUrl,
  });

  const connection = await db.createProviderConnection({
    provider: nodeId,
    authType: "apikey",
    name: `${prefix} connection`,
    apiKey: "sk-mock-upstream",
    isActive: true,
    priority: 1,
    providerSpecificData: {
      prefix,
      apiType: "chat",
      baseUrl: upstreamUrl,
      nodeName: `${prefix} node`,
    },
  });

  const qualifiedModel = `${prefix}/${model}`;
  const combo = await db.createCombo({
    name: comboName,
    models: [qualifiedModel],
    kind: null,
  });

  const keyRecord = await db.createApiKey(keyName, "perf-machine-id");
  if (apiKey && keyRecord.key !== apiKey) {
    const adapter = await (await import("../src/lib/db/driver.js")).getAdapter();
    adapter.run(`UPDATE apiKeys SET key = ? WHERE id = ?`, [apiKey, keyRecord.id]);
    keyRecord.key = apiKey;
  }

  return {
    nodeId,
    connectionId: connection.id,
    comboName: combo.name,
    key: keyRecord.key || apiKey,
    model: qualifiedModel,
  };
}

export async function seedViaHttp({
  gatewayUrl = "http://127.0.0.1:20128",
  password = process.env.INITIAL_PASSWORD || "123456",
  upstreamUrl = "http://127.0.0.1:40128/v1",
  prefix = "perf-mock",
  model = "gpt-4o-mini",
  comboName = "perf-combo",
  keyName = "perf-ladder-key",
  apiKey = "sk-mock-perf-key",
}) {
  const url = gatewayUrl.replace(/\/$/, "");

  const loginRes = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) {
    throw new Error(`Failed to log in to gateway at ${url}: HTTP ${loginRes.status}`);
  }

  let cookieHeader = "";
  if (typeof loginRes.headers.getSetCookie === "function") {
    cookieHeader = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  } else {
    const raw = loginRes.headers.get("set-cookie") || "";
    cookieHeader = raw.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }

  const authHeaders = {
    "Content-Type": "application/json",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const createNodeRes = await fetch(`${url}/api/provider-nodes`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: `${prefix} node`,
      prefix,
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: upstreamUrl,
    }),
  });
  let nodeId = `openai-compatible-chat-${prefix}`;
  if (createNodeRes.ok) {
    const nodeData = await createNodeRes.json();
    nodeId = nodeData.id || nodeData.node?.id || nodeId;
  }

  await fetch(`${url}/api/providers`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      provider: nodeId,
      name: `${prefix} connection`,
      apiKey: "sk-mock-upstream",
      providerSpecificData: {
        baseUrl: upstreamUrl,
      },
    }),
  });

  const qualifiedModel = `${prefix}/${model}`;
  await fetch(`${url}/api/combos`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: comboName,
      models: [qualifiedModel],
    }),
  });

  let clientKey = apiKey;
  const createKeyRes = await fetch(`${url}/api/keys`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: keyName }),
  });
  if (createKeyRes.ok) {
    const keyData = await createKeyRes.json();
    clientKey = keyData.key || clientKey;
  }

  return {
    nodeId,
    comboName,
    key: clientKey,
    model: qualifiedModel,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let dataDir = process.env.DATA_DIR || "";
  let url = process.env.PERF_URL || "";
  let upstream = process.env.MOCK_UPSTREAM_URL || "http://127.0.0.1:40128/v1";
  let prefix = "perf-mock";
  let model = "gpt-4o-mini";
  let combo = "perf-combo";
  let keyName = "perf-ladder-key";
  let apiKey = "sk-mock-perf-key";
  let password = process.env.INITIAL_PASSWORD || "123456";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--data-dir" && i + 1 < args.length) dataDir = args[++i];
    else if (a === "--url" && i + 1 < args.length) url = args[++i];
    else if (a === "--upstream" && i + 1 < args.length) upstream = args[++i];
    else if (a === "--prefix" && i + 1 < args.length) prefix = args[++i];
    else if (a === "--model" && i + 1 < args.length) model = args[++i];
    else if (a === "--combo" && i + 1 < args.length) combo = args[++i];
    else if (a === "--key-name" && i + 1 < args.length) keyName = args[++i];
    else if (a === "--key" && i + 1 < args.length) apiKey = args[++i];
    else if (a === "--password" && i + 1 < args.length) password = args[++i];
  }

  try {
    let res;
    if (dataDir) {
      res = await seedViaDatabase({
        dataDir,
        upstreamUrl: upstream,
        prefix,
        model,
        comboName: combo,
        keyName,
        apiKey,
      });
    } else if (url) {
      res = await seedViaHttp({
        gatewayUrl: url,
        password,
        upstreamUrl: upstream,
        prefix,
        model,
        comboName: combo,
        keyName,
        apiKey,
      });
    } else {
      console.error("Either --data-dir or --url required for perf-ladder-seed");
      process.exit(1);
    }
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(`[perf-ladder-seed] Error: ${err.message}`);
    process.exit(1);
  }
}
