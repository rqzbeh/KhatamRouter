import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

function assertPropertyMapsAreSchemas(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) {
      expect(child).not.toBeNull();
      expect(typeof child).toBe("object");
      expect(Array.isArray(child)).toBe(false);
      assertPropertyMapsAreSchemas(child);
    }
  }
  if (schema.items) assertPropertyMapsAreSchemas(schema.items);
}

describe("independent Gemini protobuf schema property map regression", () => {
  it("does not inject a string-valued type entry into a properties dictionary containing an items parameter", () => {
    const output = cleanJSONSchemaForAntigravity({ type: "object", properties: {
      payload: { type: "object", properties: {
        items: { type: "array", items: { type: "string" } },
        title: { type: "string" },
      } },
    } });
    assertPropertyMapsAreSchemas(output);
    expect(output.properties.payload.properties.items.type).toBe("array");
    expect(output.properties.payload.properties).not.toHaveProperty("type");
  });

  it("preserves parameters named after schema keywords at nested depths", () => {
    const properties = Object.fromEntries(["type", "items", "properties", "required", "enum", "const", "oneOf", "anyOf"]
      .map((name) => [name, { type: "string", description: `${name} parameter` }]));
    const output = cleanJSONSchemaForAntigravity({ type: "object", properties: {
      nested: { type: "object", properties },
    } });
    expect(Object.keys(output.properties.nested.properties).sort()).toEqual(Object.keys(properties).sort());
    assertPropertyMapsAreSchemas(output);
  });
});
