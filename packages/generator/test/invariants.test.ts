import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIR } from "@astronaut/core";
import { describe, expect, it } from "vitest";
import type {
  ComponentsObject,
  InvariantRule,
  OpenApiDocument,
  ParameterObject,
  PathItemObject,
  ResponseObject,
  SchemaObject,
} from "../src/index.js";
import { checkOpenApiInvariants, toOpenApi } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// The smallest document that satisfies every rule. Each violating case below
// starts from it and breaks exactly one rule, so a failure names the rule.
function conformingDoc(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Invariants", version: "1.0.0" },
    paths: {
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
          security: [{ bearerAuth: [] }],
        },
      },
    },
    components: {
      schemas: {
        User: { type: "object", properties: { name: { type: ["string", "null"] } } },
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  };
}

function idParam(): ParameterObject {
  return { name: "id", in: "path", required: true, schema: { type: "integer" } };
}

function ok(): Record<string, ResponseObject> {
  return { "200": { description: "OK" } };
}

function withPaths(paths: Record<string, PathItemObject>): OpenApiDocument {
  return { ...conformingDoc(), paths };
}

function withComponents(components: ComponentsObject): OpenApiDocument {
  const base = conformingDoc();
  return { ...base, components: { ...base.components, ...components } };
}

// A 3.0-style schema the emitter must never produce; cast because the 3.1
// SchemaObject type (correctly) has no `nullable` field.
const legacyNullable = { type: "string", nullable: true } as unknown as SchemaObject;

const violations: Array<[InvariantRule, OpenApiDocument]> = [
  [
    "unique-operation-ids",
    withPaths({
      "/users/{id}": {
        get: { operationId: "GetUser", parameters: [idParam()], responses: ok() },
        delete: { operationId: "GetUser", parameters: [idParam()], responses: ok() },
      },
    }),
  ],
  [
    "unique-parameters",
    withPaths({
      "/users/{id}": {
        get: { operationId: "GetUser", parameters: [idParam(), idParam()], responses: ok() },
      },
    }),
  ],
  [
    "resolvable-refs",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
              },
            },
          },
        },
      },
    }),
  ],
  [
    "resolvable-refs",
    withComponents({
      schemas: {
        User: {
          oneOf: [{ $ref: "#/components/schemas/User" }],
          discriminator: { propertyName: "kind", mapping: { x: "#/components/schemas/Nope" } },
        },
      },
    }),
  ],
  [
    "path-params-match-template",
    withPaths({ "/users/{id}": { get: { operationId: "GetUser", responses: ok() } } }),
  ],
  [
    "path-params-match-template",
    withPaths({
      "/users": { get: { operationId: "GetUser", parameters: [idParam()], responses: ok() } },
    }),
  ],
  [
    "path-params-match-template",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [{ name: "id", in: "path", schema: { type: "integer" } }],
          responses: ok(),
        },
      },
    }),
  ],
  [
    "security-schemes-defined",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: ok(),
          security: [{ apiKey: [] }],
        },
      },
    }),
  ],
  [
    "security-schemes-defined",
    withComponents({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        oauth2: { type: "oauth2" },
      },
    }),
  ],
  [
    "security-schemes-defined",
    withComponents({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        oidc: { type: "openIdConnect" },
      },
    }),
  ],
  [
    "nullable-3-1-style",
    withComponents({
      schemas: { User: { type: "object", properties: { name: legacyNullable } } },
    }),
  ],
  [
    "no-empty-schema",
    withComponents({ schemas: { User: { type: "object", properties: { name: {} } } } }),
  ],
];

describe("checkOpenApiInvariants", () => {
  it("accepts a conforming document", () => {
    expect(checkOpenApiInvariants(conformingDoc())).toEqual([]);
  });

  it.each(violations)("flags %s and nothing else", (rule, doc) => {
    const rules = new Set(checkOpenApiInvariants(doc).map((v) => v.rule));
    expect(rules).toEqual(new Set([rule]));
  });

  it("reports a readable location", () => {
    const [violation] = checkOpenApiInvariants(
      withComponents({ schemas: { User: { type: "object", properties: { name: {} } } } }),
    );
    expect(violation?.path).toBe("components.schemas.User.properties.name");
  });

  it.each(["single-route", "route-with-body", "shared-schemas", "all-features"])(
    "generator fixture %s yields an invariant-clean document",
    (name) => {
      const raw = readFileSync(join(here, "fixtures", `${name}.json`), "utf8");
      const doc = toOpenApi(parseIR(JSON.parse(raw)), { title: name, version: "1.0.0" });
      expect(checkOpenApiInvariants(doc)).toEqual([]);
    },
  );
});
