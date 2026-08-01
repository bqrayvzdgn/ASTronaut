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
