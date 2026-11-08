import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { assertGatewayUrlAllowed, isGatewaySelfHostedAllowed } from "@/lib/network/gatewayTrust.js";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type, isSelfHosted, allowInsecureTls } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    if (allowInsecureTls && !isSelfHosted) {
      return NextResponse.json({ error: "allowInsecureTls is only allowed for self-hosted nodes" }, { status: 400 });
    }

    const selfHostedRequested = Boolean(isSelfHosted);
    const selfHostedPermitted = isGatewaySelfHostedAllowed({
      request,
      isSelfHosted: selfHostedRequested,
      baseUrl,
    });

    if (selfHostedRequested && !selfHostedPermitted) {
      return NextResponse.json(
        { error: "Self-hosted gateway declaration not permitted from proxied or non-local requests" },
        { status: 400 }
      );
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const effectiveBaseUrl = (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim();
      try {
        await assertGatewayUrlAllowed(effectiveBaseUrl, {
          isSelfHosted: selfHostedRequested,
          trustedHost: new URL(effectiveBaseUrl).host,
        });
      } catch (err) {
        return NextResponse.json({ error: `Invalid base URL: ${err.message}` }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: effectiveBaseUrl,
        name: name.trim(),
        isSelfHosted: selfHostedRequested,
        allowInsecureTls: Boolean(allowInsecureTls && selfHostedRequested),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      try {
        await assertGatewayUrlAllowed(sanitizedBaseUrl, {
          isSelfHosted: selfHostedRequested,
          trustedHost: new URL(sanitizedBaseUrl).host,
        });
      } catch (err) {
        return NextResponse.json({ error: `Invalid base URL: ${err.message}` }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
        isSelfHosted: selfHostedRequested,
        allowInsecureTls: Boolean(allowInsecureTls && selfHostedRequested),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      try {
        await assertGatewayUrlAllowed(sanitizedBaseUrl, {
          isSelfHosted: selfHostedRequested,
          trustedHost: new URL(sanitizedBaseUrl).host,
        });
      } catch (err) {
        return NextResponse.json({ error: `Invalid base URL: ${err.message}` }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
        isSelfHosted: selfHostedRequested,
        allowInsecureTls: Boolean(allowInsecureTls && selfHostedRequested),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
