import { parseIR } from "@astronaut/core";
import { describe, expect, it } from "vitest";
import { toOpenApi } from "../src/index.js";

const metadata = {
  framework: "aspnet",
  filesScanned: 1,
  durationMs: 0,
  parserVersion: "0.0.1",
};

describe("multiple content types", () => {
  it("emits one requestBody/response content entry per contentTypes value", () => {
    const ir = parseIR({
      errors: [],
      metadata,
      routes: [
        {
          method: "POST",
          path: "/items",
          source: { file: "a.cs", line: 1, column: 1 },
          requestBody: {
            contentType: "application/json",
            contentTypes: ["application/json", "application/xml"],
            required: true,
            schema: { kind: "OBJECT" },
          },
          responses: [
            {
              status: 200,
              description: "OK",
              contentType: "application/json",
              contentTypes: ["application/json", "application/xml"],
              schema: { kind: "OBJECT" },
            },
          ],
        },
      ],
    });

    const doc = toOpenApi(ir);
    const op = doc.paths?.["/items"].post;
    expect(op).toBeDefined();

    expect(Object.keys(op?.requestBody?.content ?? {})).toEqual([
      "application/json",
      "application/xml",
    ]);
    expect(Object.keys(op?.responses?.["200"]?.content ?? {})).toEqual([
      "application/json",
      "application/xml",
    ]);
  });

  it("makes operationIds unique across the document", () => {
    const route = (path: string, tag: string) => ({
      method: "GET" as const,
      path,
      operationId: "Get",
      tags: [tag],
      source: { file: "a.cs", line: 1, column: 1 },
      responses: [{ status: 200, description: "OK" }],
    });
    const doc = toOpenApi(
      parseIR({
        errors: [],
        metadata,
        routes: [route("/a", "Rating"), route("/b", "Suggestion"), route("/c", "Rating")],
      }),
    );

    const ids = [
      doc.paths?.["/a"].get?.operationId,
      doc.paths?.["/b"].get?.operationId,
      doc.paths?.["/c"].get?.operationId,
    ];
    expect(ids[0]).toBe("Get");
    expect(new Set(ids).size).toBe(3); // all unique
    expect(ids).toContain("Suggestion_Get");
  });

  it("emits additionalProperties for a map schema", () => {
    const ir = parseIR({
      errors: [],
      metadata,
      routes: [
        {
          method: "POST",
          path: "/bag",
          source: { file: "a.cs", line: 1, column: 1 },
          requestBody: {
            contentType: "application/json",
            required: true,
            schema: {
              kind: "OBJECT",
              additionalProperties: {
                kind: "PRIMITIVE",
                primitiveType: "integer",
                format: "int32",
              },
            },
          },
          responses: [{ status: 200, description: "OK" }],
        },
      ],
    });

    const doc = toOpenApi(ir);
    const body = doc.paths?.["/bag"].post?.requestBody?.content["application/json"].schema;
    expect(body?.type).toBe("object");
    expect(body?.additionalProperties).toEqual({ type: "integer", format: "int32" });
  });

  it("emits a discriminator with $ref mapping for a ONE_OF schema", () => {
    const doc = toOpenApi(
      parseIR({
        errors: [],
        metadata,
        routes: [
          {
            method: "GET",
            path: "/a",
            source: { file: "a.cs", line: 1, column: 1 },
            responses: [
              {
                status: 200,
                description: "OK",
                schema: {
                  kind: "ONE_OF",
                  variants: [
                    { kind: "REFERENCE", refName: "Dog" },
                    { kind: "REFERENCE", refName: "Cat" },
                  ],
                  discriminator: "kind",
                  discriminatorMapping: { dog: "Dog", cat: "Cat" },
                },
              },
            ],
          },
        ],
      }),
    );

    const schema = doc.paths?.["/a"].get?.responses["200"].content?.["application/json"].schema;
    expect(schema?.oneOf).toHaveLength(2);
    expect(schema?.discriminator).toEqual({
      propertyName: "kind",
      mapping: {
        dog: "#/components/schemas/Dog",
        cat: "#/components/schemas/Cat",
      },
    });
  });

  it("falls back to the single contentType when contentTypes is absent", () => {
    const ir = parseIR({
      errors: [],
      metadata,
      routes: [
        {
          method: "POST",
          path: "/one",
          source: { file: "a.cs", line: 1, column: 1 },
          requestBody: {
            contentType: "multipart/form-data",
            required: true,
            schema: { kind: "PRIMITIVE", primitiveType: "string", format: "binary" },
          },
          responses: [{ status: 201, description: "Created" }],
        },
      ],
    });

    const doc = toOpenApi(ir);
    const op = doc.paths?.["/one"].post;
    expect(Object.keys(op?.requestBody?.content ?? {})).toEqual(["multipart/form-data"]);
  });
});
