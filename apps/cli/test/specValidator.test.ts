import type { ParseResult } from "@astronaut/core";
import { toOpenApi } from "@astronaut/generator";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";

// Guards the e2e quality gate itself: if the validator ever stops discriminating
// (misconfigured, API drift), the pipeline test would pass vacuously. These fast
// checks prove it still accepts valid and rejects invalid documents.
describe("OpenAPI 3.1 validator (gate sanity)", () => {
  it("accepts a minimal valid document", async () => {
    const res = await new Validator().validate({
      openapi: "3.1.0",
      info: { title: "x", version: "1.0.0" },
      paths: {},
    });
    expect(res.valid).toBe(true);
  });

  it("rejects a structurally invalid document", async () => {
    // Missing the required `info` object.
    const res = await new Validator().validate({ openapi: "3.1.0" });
    expect(res.valid).toBe(false);
  });
});

// oauth2/openIdConnect security schemes must satisfy the 3.1 meta-schema:
// oauth2 requires a `flows` object; openIdConnect requires an `openIdConnectUrl`.
// The concrete flow/URL values aren't recoverable from [Authorize] alone, so the
// generator emits spec-valid stand-ins (empty flows / a documented placeholder URL).
describe("OpenAPI 3.1 — generated oauth2/openIdConnect schemes are spec-valid", () => {
  function authFixture(auth: ParseResult["routes"][number]["auth"]): ParseResult {
    return {
      routes: [
        { method: "GET", path: "/secure", auth, source: { file: "x.cs", line: 1, column: 0 } },
      ],
      errors: [],
      metadata: { framework: "aspnet", filesScanned: 1, durationMs: 1, parserVersion: "0.0.1" },
    };
  }

  it.each([
    ["oauth2", { type: "oauth2", id: "oauth2" }],
    ["openIdConnect", { type: "openIdConnect", id: "openIdConnect" }],
  ] as const)("%s scheme validates against the 3.1 meta-schema", async (_name, auth) => {
    const doc = toOpenApi(authFixture(auth), { title: "x", version: "1.0.0" });
    const res = await new Validator().validate(doc as unknown as Record<string, unknown>);
    expect(res.valid, JSON.stringify(res.errors, null, 2)).toBe(true);
  });
});
