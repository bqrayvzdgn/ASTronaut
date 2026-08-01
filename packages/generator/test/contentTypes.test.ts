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

    expect(Object.keys(op!.requestBody!.content)).toEqual([
      "application/json",
      "application/xml",
    ]);
    expect(Object.keys(op!.responses["200"].content!)).toEqual([
      "application/json",
      "application/xml",
    ]);
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
    expect(Object.keys(op!.requestBody!.content)).toEqual(["multipart/form-data"]);
  });
});
