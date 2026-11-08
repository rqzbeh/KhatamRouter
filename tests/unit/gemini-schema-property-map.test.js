import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import {
  openaiToGeminiRequest,
  openaiToGeminiCLIRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToVertexRequest } from "../../open-sse/translator/request/openai-to-vertex.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

function assertPropertyMapsAreSchemas(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      expect(child, `property "${key}" should be an object`).not.toBeNull();
      expect(typeof child, `property "${key}" should be an object`).toBe("object");
      expect(Array.isArray(child), `property "${key}" should not be an array`).toBe(false);
      assertPropertyMapsAreSchemas(child);
    }
  }
  if (schema.items && typeof schema.items === "object") {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) assertPropertyMapsAreSchemas(item);
    } else {
      assertPropertyMapsAreSchemas(schema.items);
    }
  }
}

describe("Gemini schema property dictionary safety and keyword collision handling", () => {
  it("preserves comprehensive set of schema keyword names as property keys at multiple depths", () => {
    const keywordNames = [
      "type", "items", "properties", "required", "const", "enum",
      "oneOf", "anyOf", "allOf", "not", "prefixItems", "title",
      "description", "default", "examples", "format", "minLength",
      "maxLength", "minimum", "maximum"
    ];

    const properties = Object.fromEntries(
      keywordNames.map((name) => [
        name,
        { type: "string", description: `Field for ${name}` },
      ])
    );

    const schema = {
      type: "object",
      properties: {
        level1: {
          type: "object",
          properties: {
            ...properties,
            level2: {
              type: "object",
              properties: {
                ...properties,
              },
            },
          },
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    assertPropertyMapsAreSchemas(cleaned);

    const level1Keys = Object.keys(cleaned.properties.level1.properties);
    const level2Keys = Object.keys(cleaned.properties.level1.properties.level2.properties);

    for (const name of keywordNames) {
      expect(level1Keys).toContain(name);
      expect(level2Keys).toContain(name);
    }
  });

  it("handles deeply nested tools with arrays of objects having items and type properties", () => {
    const schema = {
      type: "object",
      properties: {
        pipeline: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", description: "Step type identifier" },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        properties: { type: "string", description: "Nested property name" },
                        required: { type: "boolean", description: "Whether it is required" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    assertPropertyMapsAreSchemas(cleaned);

    const steps = cleaned.properties.pipeline.properties.steps;
    expect(steps.type).toBe("array");
    expect(steps.items.type).toBe("object");

    const stepProps = steps.items.properties;
    expect(stepProps).not.toHaveProperty("type", "array");
    expect(stepProps.type.type).toBe("string");
    expect(stepProps.items.type).toBe("array");

    const innerProps = stepProps.items.items.properties;
    expect(innerProps.properties.type).toBe("string");
    expect(innerProps.required.type).toBe("boolean");
  });

  it("distinguishes schema enum constraints from parameters named enum and preserves enum data", () => {
    const schema = {
      type: "object",
      properties: {
        enum: {
          type: "string",
          description: "Parameter named enum",
        },
        mode: {
          type: "string",
          enum: ["fast", "accurate", 42],
        },
        status: {
          const: "active",
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    assertPropertyMapsAreSchemas(cleaned);

    expect(cleaned.properties.enum).toBeDefined();
    expect(cleaned.properties.enum.type).toBe("string");
    expect(cleaned.properties.enum.description).toBe("Parameter named enum");

    // mode enum values converted to strings
    expect(cleaned.properties.mode.enum).toEqual(["fast", "accurate", "42"]);
    expect(cleaned.properties.mode.type).toBe("string");

    // const converted to enum
    expect(cleaned.properties.status.enum).toEqual(["active"]);
    expect(cleaned.properties.status.type).toBe("string");
    expect(cleaned.properties.status).not.toHaveProperty("const");
  });

  it("preserves type predicates: removes items from non-array and properties from non-object", () => {
    const schema = {
      type: "object",
      properties: {
        nonArrayWithItems: {
          type: "string",
          items: { type: "string" },
        },
        nonObjectWithProperties: {
          type: "array",
          items: { type: "string" },
          properties: { extra: { type: "string" } },
          required: ["extra"],
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    assertPropertyMapsAreSchemas(cleaned);

    expect(cleaned.properties.nonArrayWithItems.type).toBe("string");
    expect(cleaned.properties.nonArrayWithItems).not.toHaveProperty("items");

    expect(cleaned.properties.nonObjectWithProperties.type).toBe("array");
    expect(cleaned.properties.nonObjectWithProperties).not.toHaveProperty("properties");
    expect(cleaned.properties.nonObjectWithProperties).not.toHaveProperty("required");
    expect(cleaned.properties.nonObjectWithProperties.items.type).toBe("string");
  });
});

describe("Cross-provider wire paths schema property map preservation", () => {
  const toolSchema = {
    type: "object",
    properties: {
      type: { type: "string", description: "Resource type" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            properties: { type: "string", description: "Sub-property" },
            required: { type: "string", description: "Requirement flag" },
            enum: { type: "string", description: "Allowed values" },
            const: { type: "string", description: "Constant value" },
            oneOf: { type: "string", description: "One-of selection" },
            anyOf: { type: "string", description: "Any-of selection" },
          },
        },
      },
    },
    required: ["type"],
  };

  const sampleBody = {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Process data" }],
    tools: [
      {
        type: "function",
        function: {
          name: "schema_inspector",
          description: "Inspect schema with keywords",
          parameters: toolSchema,
        },
      },
    ],
  };

  it("preserves keyword-named properties in public openaiToGeminiRequest wire path", () => {
    const req = openaiToGeminiRequest("gemini-2.5-flash", sampleBody, true);
    expect(req.tools).toBeDefined();
    expect(req.tools.length).toBe(1);

    const fnDecl = req.tools[0].functionDeclarations[0];
    expect(fnDecl.name).toBe("schema_inspector");

    const params = fnDecl.parameters;
    assertPropertyMapsAreSchemas(params);
    expect(params.type).toBe("object");
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");
    expect(typeof params.properties.type).toBe("object");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
    expect(itemProps.enum.type).toBe("string");
    expect(itemProps.const.type).toBe("string");
    expect(itemProps.oneOf.type).toBe("string");
    expect(itemProps.anyOf.type).toBe("string");
  });

  it("preserves keyword-named properties in openaiToGeminiCLIRequest wire path", () => {
    const req = openaiToGeminiCLIRequest("gemini-2.5-flash", sampleBody, true);
    expect(req.tools).toBeDefined();
    const fnDecl = req.tools[0].functionDeclarations[0];
    const params = fnDecl.parameters;

    assertPropertyMapsAreSchemas(params);
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
    expect(itemProps.enum.type).toBe("string");
  });

  it("preserves keyword-named properties in AntigravityExecutor transformRequest wire path", () => {
    const executor = new AntigravityExecutor();
    const antigravityBody = {
      model: "gemini-2.5-flash",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "deep_tool",
                description: "Deep tool",
                parameters: toolSchema,
              },
            ],
          },
        ],
      },
    };

    const transformed = executor.transformRequest(
      "gemini-2.5-flash",
      antigravityBody,
      true,
      { accessToken: "fake-token" }
    );

    const fnDecl = transformed.request.tools[0].functionDeclarations[0];
    const params = fnDecl.parameters;

    assertPropertyMapsAreSchemas(params);
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
    expect(itemProps.enum.type).toBe("string");
    expect(itemProps.const.type).toBe("string");
  });

  it("preserves keyword-named properties in openaiToVertexRequest wire path", () => {
    const req = openaiToVertexRequest("gemini-2.5-flash", sampleBody, true, null);
    expect(req.tools).toBeDefined();
    const fnDecl = req.tools[0].functionDeclarations[0];
    const params = fnDecl.parameters;

    assertPropertyMapsAreSchemas(params);
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
    expect(itemProps.enum.type).toBe("string");
  });

  it("preserves keyword-named properties with Anthropic/Claude style input tools in openaiToGeminiRequest", () => {
    const claudeStyleBody = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Run tool" }],
      tools: [
        {
          name: "claude_schema_inspector",
          description: "Inspect schema in claude format",
          input_schema: toolSchema,
        },
      ],
    };

    const req = openaiToGeminiRequest("gemini-2.5-flash", claudeStyleBody, true);
    expect(req.tools).toBeDefined();
    const fnDecl = req.tools[0].functionDeclarations[0];
    expect(fnDecl.name).toBe("claude_schema_inspector");
    const params = fnDecl.parameters;

    assertPropertyMapsAreSchemas(params);
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
  });

  it("preserves keyword-named properties in openaiToAntigravityRequest envelope wire path", () => {
    const req = openaiToAntigravityRequest("gemini-2.5-flash", sampleBody, true);
    expect(req.request).toBeDefined();
    expect(req.request.tools).toBeDefined();
    const fnDecl = req.request.tools[0].functionDeclarations[0];
    const params = fnDecl.parameters;

    assertPropertyMapsAreSchemas(params);
    expect(params.properties.type.type).toBe("string");
    expect(params.properties.items.type).toBe("array");

    const itemProps = params.properties.items.items.properties;
    expect(itemProps.properties.type).toBe("string");
    expect(itemProps.required.type).toBe("string");
    expect(itemProps.enum.type).toBe("string");
  });
});
