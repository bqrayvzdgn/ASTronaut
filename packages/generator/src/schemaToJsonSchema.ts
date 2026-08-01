import type { Constraints, Schema } from "@astronaut/core";
import type { SchemaObject, SchemaType } from "./types.js";

const PRIMITIVE_TO_JSON_TYPE: Record<string, SchemaType> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
  null: "null",
};

export function schemaToJsonSchema(schema: Schema): SchemaObject {
  const out = buildJsonSchema(schema);
  return applyNullability(out, schema);
}

function buildJsonSchema(schema: Schema): SchemaObject {
  switch (schema.kind) {
    case "PRIMITIVE":
      return buildPrimitive(schema);
    case "OBJECT":
      return buildObject(schema);
    case "ARRAY":
      return buildArray(schema);
    case "REFERENCE":
      return buildReference(schema);
    case "ONE_OF":
      return buildOneOf(schema);
    case "ANY_OF":
      return { anyOf: (schema.variants ?? []).map(schemaToJsonSchema) };
    case "ALL_OF":
      return { allOf: (schema.variants ?? []).map(schemaToJsonSchema) };
  }
}

function buildPrimitive(schema: Schema): SchemaObject {
  const type = schema.primitiveType ? PRIMITIVE_TO_JSON_TYPE[schema.primitiveType] : undefined;
  const out: SchemaObject = {};
  if (type) out.type = type;
  if (schema.format) out.format = schema.format;
  applyCommon(out, schema);
  applyConstraints(out, schema.constraints);
  return out;
}

function buildObject(schema: Schema): SchemaObject {
  const out: SchemaObject = { type: "object" };
  if (schema.properties) {
    out.properties = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      out.properties[key] = schemaToJsonSchema(propSchema);
    }
  }
  if (schema.requiredProperties && schema.requiredProperties.length > 0) {
    out.required = [...schema.requiredProperties];
  }
  if (schema.additionalProperties) {
    out.additionalProperties = schemaToJsonSchema(schema.additionalProperties);
  }
  applyCommon(out, schema);
  applyConstraints(out, schema.constraints);
  return out;
}

function buildArray(schema: Schema): SchemaObject {
  const out: SchemaObject = { type: "array" };
  if (schema.items) {
    out.items = schemaToJsonSchema(schema.items);
  }
  applyCommon(out, schema);
  applyConstraints(out, schema.constraints);
  return out;
}

function buildReference(schema: Schema): SchemaObject {
  if (!schema.refName) {
    throw new Error("REFERENCE schema is missing refName");
  }
  return { $ref: `#/components/schemas/${schema.refName}` };
}

function buildOneOf(schema: Schema): SchemaObject {
  const out: SchemaObject = { oneOf: (schema.variants ?? []).map(schemaToJsonSchema) };
  if (schema.discriminator) {
    out.discriminator = { propertyName: schema.discriminator };
    if (schema.discriminatorMapping && Object.keys(schema.discriminatorMapping).length > 0) {
      const mapping: Record<string, string> = {};
      for (const [value, refName] of Object.entries(schema.discriminatorMapping)) {
        mapping[value] = `#/components/schemas/${refName}`;
      }
      out.discriminator.mapping = mapping;
    }
  }
  return out;
}

function applyCommon(out: SchemaObject, schema: Schema): void {
  if (schema.description) out.description = schema.description;
  if (schema.defaultValue !== undefined) {
    out.default = parseJsonLiteral(schema.defaultValue);
  }
  if (schema.example !== undefined) {
    out.example = parseJsonLiteral(schema.example);
  }
}

function applyConstraints(out: SchemaObject, constraints: Constraints | undefined): void {
  if (!constraints) return;
  if (constraints.minimum !== undefined) out.minimum = constraints.minimum;
  if (constraints.maximum !== undefined) out.maximum = constraints.maximum;
  if (constraints.exclusiveMinimum !== undefined) {
    out.exclusiveMinimum = constraints.exclusiveMinimum;
  }
  if (constraints.exclusiveMaximum !== undefined) {
    out.exclusiveMaximum = constraints.exclusiveMaximum;
  }
  if (constraints.minLength !== undefined) out.minLength = constraints.minLength;
  if (constraints.maxLength !== undefined) out.maxLength = constraints.maxLength;
  if (constraints.minItems !== undefined) out.minItems = constraints.minItems;
  if (constraints.maxItems !== undefined) out.maxItems = constraints.maxItems;
  if (constraints.uniqueItems !== undefined) out.uniqueItems = constraints.uniqueItems;
  if (constraints.pattern !== undefined) out.pattern = constraints.pattern;
  if (constraints.multipleOf !== undefined) out.multipleOf = constraints.multipleOf;
  if (constraints.enumValues && constraints.enumValues.length > 0) {
    out.enum = constraints.enumValues.map(parseJsonLiteral);
  }
}

// OpenAPI 3.1 expresses nullability via `type: [..., "null"]` for non-composite
// schemas. For $ref and composite (oneOf/anyOf/allOf) we wrap with `oneOf` and
// add a `{type: "null"}` variant — `allOf` cannot directly express null.
function applyNullability(out: SchemaObject, schema: Schema): SchemaObject {
  if (!schema.nullable) return out;
  if (out.$ref !== undefined) {
    return { oneOf: [{ $ref: out.$ref }, { type: "null" }] };
  }
  if (out.oneOf) {
    return { ...out, oneOf: [...out.oneOf, { type: "null" }] };
  }
  if (out.anyOf) {
    return { ...out, anyOf: [...out.anyOf, { type: "null" }] };
  }
  if (out.allOf) {
    // allOf cannot directly admit null — wrap the entire schema in oneOf.
    return { oneOf: [out, { type: "null" }] };
  }
  if (typeof out.type === "string") {
    return { ...out, type: [out.type, "null"] };
  }
  if (Array.isArray(out.type)) {
    if (out.type.includes("null")) return out;
    return { ...out, type: [...out.type, "null"] };
  }
  // No type at all (degenerate); fall back to wrapping.
  return { oneOf: [out, { type: "null" }] };
}

function parseJsonLiteral(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
