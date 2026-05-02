import { describe, expect, it } from "vitest";
import type { ParseResult } from "../src/ir.js";
import { IRValidationError, parseIR, schemaSchema } from "../src/validate.js";

const minimalValidResult: ParseResult = {
  routes: [
    {
      method: "GET",
      path: "/health",
      source: { file: "src/app.ts", line: 1, column: 0 },
    },
  ],
  errors: [],
  metadata: {
    framework: "express",
    filesScanned: 1,
    durationMs: 12,
    parserVersion: "0.0.1",
  },
};

describe("parseIR", () => {
  it("accepts a minimal valid result", () => {
    const result = parseIR(minimalValidResult);
    expect(result.routes[0]?.method).toBe("GET");
    expect(result.routes[0]?.path).toBe("/health");
  });

  it("rejects when path is missing leading slash", () => {
    const bad = {
      ...minimalValidResult,
      routes: [{ ...minimalValidResult.routes[0]!, path: "health" }],
    };
    expect(() => parseIR(bad)).toThrow(IRValidationError);
  });

  it("rejects unknown HTTP method", () => {
    const bad = {
      ...minimalValidResult,
      routes: [{ ...minimalValidResult.routes[0]!, method: "FOO" }],
    };
    expect(() => parseIR(bad)).toThrow(IRValidationError);
  });

  it("rejects extra unknown root keys (strict)", () => {
    const bad = { ...minimalValidResult, mystery: 42 };
    expect(() => parseIR(bad)).toThrow(IRValidationError);
  });

  it("includes the failing field path in the error message", () => {
    const bad = {
      ...minimalValidResult,
      metadata: { ...minimalValidResult.metadata, filesScanned: -1 },
    };
    try {
      parseIR(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IRValidationError);
      expect((err as IRValidationError).message).toContain("metadata.filesScanned");
    }
  });
});

describe("schema (recursive)", () => {
  it("accepts deeply nested OBJECT/ARRAY/REFERENCE composition", () => {
    const nested = {
      kind: "OBJECT" as const,
      properties: {
        ids: {
          kind: "ARRAY" as const,
          items: {
            kind: "PRIMITIVE" as const,
            primitiveType: "integer" as const,
            format: "int64",
          },
        },
        owner: { kind: "REFERENCE" as const, refName: "User" },
      },
      requiredProperties: ["ids"],
    };
    const result = schemaSchema.safeParse(nested);
    expect(result.success).toBe(true);
  });

  it("accepts ONE_OF with variants", () => {
    const oneOf = {
      kind: "ONE_OF" as const,
      variants: [
        { kind: "PRIMITIVE" as const, primitiveType: "string" as const },
        { kind: "PRIMITIVE" as const, primitiveType: "integer" as const },
      ],
    };
    const result = schemaSchema.safeParse(oneOf);
    expect(result.success).toBe(true);
  });
});
