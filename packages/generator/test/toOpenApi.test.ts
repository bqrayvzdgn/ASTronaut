import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseResult } from "@astronaut/core";
import { parseIR } from "@astronaut/core";
import { describe, expect, it } from "vitest";
import { toJson, toOpenApi, toYaml } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): ParseResult {
  const raw = readFileSync(join(here, "fixtures", `${name}.json`), "utf8");
  return parseIR(JSON.parse(raw));
}

describe("toOpenApi — fixture snapshots", () => {
  it("single-route → YAML matches snapshot", () => {
    const doc = toOpenApi(loadFixture("single-route"), { title: "Demo API", version: "1.0.0" });
    expect(toYaml(doc)).toMatchSnapshot();
  });

  it("route-with-body → YAML matches snapshot", () => {
    const doc = toOpenApi(loadFixture("route-with-body"), {
      title: "Users API",
      version: "1.0.0",
    });
    expect(toYaml(doc)).toMatchSnapshot();
  });

  it("shared-schemas → YAML matches snapshot", () => {
    const doc = toOpenApi(loadFixture("shared-schemas"), {
      title: "Users API",
      version: "1.0.0",
    });
    expect(toYaml(doc)).toMatchSnapshot();
  });

  it("all-features → YAML matches snapshot", () => {
    const doc = toOpenApi(loadFixture("all-features"), {
      title: "Items API",
      version: "1.0.0",
      description: "An items service.",
    });
    expect(toYaml(doc)).toMatchSnapshot();
  });

  it("all-features → JSON matches snapshot", () => {
    const doc = toOpenApi(loadFixture("all-features"), {
      title: "Items API",
      version: "1.0.0",
    });
    expect(toJson(doc)).toMatchSnapshot();
  });
});

describe("toOpenApi — structural invariants", () => {
  it("emits openapi: 3.1.0", () => {
    const doc = toOpenApi(loadFixture("single-route"));
    expect(doc.openapi).toBe("3.1.0");
  });

  it("derives title from framework when not provided", () => {
    const doc = toOpenApi(loadFixture("single-route"));
    expect(doc.info.title).toBe("aspnet API");
  });

  it("uses provided title/version over derived ones", () => {
    const doc = toOpenApi(loadFixture("single-route"), {
      title: "Custom",
      version: "2.5.0",
    });
    expect(doc.info.title).toBe("Custom");
    expect(doc.info.version).toBe("2.5.0");
  });

  it("groups multiple methods on the same path", () => {
    const doc = toOpenApi(loadFixture("shared-schemas"));
    const path = doc.paths?.["/users/{id}"];
    expect(path).toBeDefined();
    expect(path?.get).toBeDefined();
    expect(path?.patch).toBeDefined();
  });

  it("hoists sharedSchemas under components.schemas", () => {
    const doc = toOpenApi(loadFixture("shared-schemas"));
    expect(doc.components?.schemas?.User).toBeDefined();
    expect(doc.components?.schemas?.UpdateUserDto).toBeDefined();
    expect(doc.components?.schemas?.ProblemDetails).toBeDefined();
  });

  it("emits REFERENCE as $ref to components.schemas", () => {
    const doc = toOpenApi(loadFixture("shared-schemas"));
    const getOp = doc.paths?.["/users/{id}"]?.get;
    expect(getOp?.responses["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/User",
    });
  });

  it("dedupes security schemes across routes", () => {
    const doc = toOpenApi(loadFixture("all-features"));
    const schemes = doc.components?.securitySchemes ?? {};
    expect(Object.keys(schemes).sort()).toEqual(["adminKey", "bearerAuth"]);
    expect(schemes.bearerAuth).toEqual({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(schemes.adminKey).toEqual({ type: "apiKey", name: "X-Admin-Key", in: "header" });
  });

  it("dedupes tags from all routes", () => {
    const doc = toOpenApi(loadFixture("all-features"));
    expect(doc.tags?.map((t) => t.name).sort()).toEqual(["admin", "items"]);
  });

  it("marks path params as required even when IR says otherwise", () => {
    const doc = toOpenApi(loadFixture("all-features"));
    const deleteOp = doc.paths?.["/items/{id}"]?.delete;
    const pathParam = deleteOp?.parameters?.find((p) => p.in === "path");
    expect(pathParam?.required).toBe(true);
  });

  it("emits enum values from JSON-serialized literals", () => {
    const doc = toOpenApi(loadFixture("all-features"));
    const listOp = doc.paths?.["/items"]?.get;
    const sortParam = listOp?.parameters?.find((p) => p.name === "sort");
    expect(sortParam?.schema.enum).toEqual(["asc", "desc"]);
    expect(sortParam?.schema.default).toBe("asc");
  });

  it("emits exclusiveMinimum as a numeric bound (3.1 style)", () => {
    const doc = toOpenApi(loadFixture("all-features"));
    const priceSchema = doc.components?.schemas?.Item?.properties?.price;
    expect(priceSchema?.exclusiveMinimum).toBe(0);
  });

  it("expresses nullable primitive via type array", () => {
    const doc = toOpenApi(loadFixture("shared-schemas"));
    const nameSchema = doc.components?.schemas?.User?.properties?.name;
    expect(nameSchema?.type).toEqual(["string", "null"]);
  });

  it("does not emit empty components", () => {
    const doc = toOpenApi(loadFixture("single-route"));
    expect(doc.components).toBeUndefined();
  });

  it("emits responses.default when route has no responses", () => {
    const minimal: ParseResult = {
      routes: [
        {
          method: "GET",
          path: "/x",
          source: { file: "x.cs", line: 1, column: 0 },
        },
      ],
      errors: [],
      metadata: { framework: "aspnet", filesScanned: 1, durationMs: 1, parserVersion: "0.0.1" },
    };
    const doc = toOpenApi(minimal);
    expect(doc.paths?.["/x"]?.get?.responses.default).toEqual({ description: "" });
  });

  function authFixture(auth: ParseResult["routes"][number]["auth"]): ParseResult {
    return {
      routes: [
        {
          method: "GET",
          path: "/secure",
          auth,
          source: { file: "x.cs", line: 1, column: 0 },
        },
      ],
      errors: [],
      metadata: { framework: "aspnet", filesScanned: 1, durationMs: 1, parserVersion: "0.0.1" },
    };
  }

  it("emits a flows object for oauth2 schemes (3.1 requires it)", () => {
    const doc = toOpenApi(authFixture({ type: "oauth2", id: "oauth2" }));
    const scheme = doc.components?.securitySchemes?.oauth2;
    expect(scheme?.type).toBe("oauth2");
    expect(scheme?.flows).toEqual({});
  });

  it("emits an openIdConnectUrl for openIdConnect schemes (3.1 requires it)", () => {
    const doc = toOpenApi(authFixture({ type: "openIdConnect", id: "openIdConnect" }));
    const scheme = doc.components?.securitySchemes?.openIdConnect;
    expect(scheme?.type).toBe("openIdConnect");
    expect(typeof scheme?.openIdConnectUrl).toBe("string");
    expect(() => new URL(scheme?.openIdConnectUrl ?? "")).not.toThrow();
  });
});
