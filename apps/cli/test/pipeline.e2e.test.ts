import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toOpenApi } from "@astronaut/generator";
import { resolveDotnetAnalyzer, runAnalyzer } from "@astronaut/parser-bridge";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { detectAspnetProject } from "../src/detect.js";

// Full pipeline over the checked-in fixture projects:
//   real C# source → analyzer → ParseResult JSON → parseIR (zod) → toOpenApi → validate.
//
// Two guards the unit suites can't provide:
//   1. Round-trip: runAnalyzer validates the analyzer's ACTUAL stdout through the
//      same zod IR schema the generator relies on (catches casing / enum / null
//      drift between the analyzer and the IR contract).
//   2. Spec-validity: the emitted document is checked against the OpenAPI 3.1
//      meta-schema (catches invalid output like duplicate operationIds/params).

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesDir = join(repoRoot, "fixtures", "dotnet");

// The analyzer must be built (`pnpm build:analyzers`). Skip cleanly otherwise so
// the fast unit loop doesn't require a .NET toolchain.
let analyzerBuilt = false;
try {
  analyzerBuilt = existsSync(resolveDotnetAnalyzer({ repoRootHint: repoRoot }));
} catch {
  analyzerBuilt = false;
}

// Only fixture directories that actually contain an analyzable project (a
// .csproj/.sln) — reuses the CLI's own detection so non-project dirs (e.g. a
// stale build-artifact-only folder) are skipped exactly as the CLI would.
const fixtures = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => detectAspnetProject(join(fixturesDir, name)) !== null)
  : [];

describe.skipIf(!analyzerBuilt)("pipeline: analyzer → IR → OpenAPI 3.1 (real fixtures)", () => {
  if (!analyzerBuilt) {
    it("skipped — run `pnpm build:analyzers` to enable", () => {});
    return;
  }

  it.each(fixtures)("%s → spec-valid OpenAPI 3.1", async (fixture) => {
    const projectPath = join(fixturesDir, fixture);

    // runAnalyzer runs parseIR internally → the IR round-trip guard.
    const result = await runAnalyzer({ projectPath, repoRootHint: repoRoot });

    const doc = toOpenApi(result, { title: fixture, version: "1.0.0" });

    const validator = new Validator();
    const res = await validator.validate(doc as unknown as Record<string, unknown>);
    expect(res.valid, `${fixture}: ${JSON.stringify(res.errors, null, 2)}`).toBe(true);

    // Semantic invariants the 3.1 meta-schema does not enforce but the spec
    // requires — these are the classes that bit us live (operationId collisions,
    // duplicate params).
    const verbs = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
    const operationIds: string[] = [];
    for (const item of Object.values(doc.paths ?? {})) {
      for (const verb of verbs) {
        const op = item[verb];
        if (!op) continue;
        if (op.operationId) operationIds.push(op.operationId);
        const paramKeys = (op.parameters ?? []).map((p) => `${p.in}:${p.name}`);
        expect(new Set(paramKeys).size, `${fixture} ${verb}: duplicate parameter`).toBe(
          paramKeys.length,
        );
      }
    }
    expect(new Set(operationIds).size, `${fixture}: duplicate operationId`).toBe(
      operationIds.length,
    );
  });
});
