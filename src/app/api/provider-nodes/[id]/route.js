import { NextResponse } from "next/server";
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/models";
import { assertGatewayUrlAllowed, isGatewaySelfHostedAllowed } from "@/lib/network/gatewayTrust.js";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, isSelfHosted, allowInsecureTls } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    const effectiveIsSelfHosted = isSelfHosted !== undefined ? Boolean(isSelfHosted) : Boolean(node.isSelfHosted);
    const effectiveAllowInsecure = allowInsecureTls !== undefined ? Boolean(allowInsecureTls) : Boolean(node.allowInsecureTls);

    if (effectiveAllowInsecure && !effectiveIsSelfHosted) {
      return NextResponse.json({ error: "allowInsecureTls is only allowed for self-hosted nodes" }, { status: 400 });
    }

    // Check if security posture is being changed or newly granted:
    // Remote operators can update metadata (name, prefix, apiType) of an already trusted node
    // without lockout, but changing baseUrl or newly enabling self-hosted / insecure TLS requires local origin.
    const isBaseUrlChanged = baseUrl && baseUrl.trim() !== node.baseUrl;
    const isSelfHostedElevated = effectiveIsSelfHosted && !node.isSelfHosted;
    const isTlsElevated = effectiveAllowInsecure && !node.allowInsecureTls;
    const isSecurityElevation = isBaseUrlChanged || isSelfHostedElevated || isTlsElevated;

    if (effectiveIsSelfHosted && isSecurityElevation) {
      const allowed = isGatewaySelfHostedAllowed({
        request,
        isSelfHosted: true,
        baseUrl: baseUrl || node.baseUrl,
      });
      if (!allowed) {
        return NextResponse.json(
          { error: "Self-hosted gateway security update not permitted from proxied or non-local requests" },
          { status: 400 }
        );
      }
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();

    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    try {
      await assertGatewayUrlAllowed(sanitizedBaseUrl, {
        isSelfHosted: effectiveIsSelfHosted,
        trustedHost: new URL(sanitizedBaseUrl).host,
      });
    } catch (err) {
      return NextResponse.json({ error: `Invalid base URL: ${err.message}` }, { status: 400 });
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
      isSelfHosted: effectiveIsSelfHosted,
      allowInsecureTls: effectiveAllowInsecure,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
        }
      })
    )));

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
