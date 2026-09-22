import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkOpenApiInvariants, toOpenApi, toYaml } from "@astronaut/generator";
import { resolveDotnetAnalyzer, runAnalyzer } from "@astronaut/parser-bridge";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { detectAspnetProject } from "../src/detect.js";
import { readProjectInfoFor } from "../src/projectInfo.js";
import { GOLDEN_FILE, fixturesDir, goldenPath, normalizeEol, repoRoot } from "./support/runCli.js";

// Full pipeline over the checked-in fixture projects, in-process — the same
// steps `analyzeCommand` runs, so IR/zod errors surface directly:
//   real C# source → analyzer → ParseResult JSON → parseIR → toOpenApi → toYaml
//
// Three gates per fixture:
//   1. Golden: the emitted YAML matches fixtures/dotnet/<name>/expected.openapi.yaml
//      byte for byte. Update deliberately with `pnpm test:e2e -u`, then review the diff.
//   2. Spec validity: the OpenAPI 3.1 meta-schema.
//   3. Invariants the meta-schema cannot express (docs/test-scenarios.md §T).
// The CLI process itself is checked against the same goldens in cli.e2e.test.ts.

// Fixtures that must NOT produce a document (the CLI exits non-zero). They are
// covered by cli.e2e.test.ts and skipped here.
const FAILURE_FIXTURES = new Set<string>(["diagnostics-load-failure"]);

// The analyzer must be built (`pnpm build:analyzers`). Skip cleanly otherwise so
// the suite does not require a .NET toolchain just to load.
let analyzerBuilt = false;
try {
  analyzerBuilt = existsSync(resolveDotnetAnalyzer({ repoRootHint: repoRoot }));
} catch {
  analyzerBuilt = false;
}

const fixtureDirs = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

// Reuses the CLI's own detection so non-project dirs are skipped exactly as the
// CLI would skip them.
const fixtures = fixtureDirs
  .filter((name) => !FAILURE_FIXTURES.has(name))
  .filter((name) => detectAspnetProject(join(fixturesDir, name)) !== null);

describe.skipIf(!analyzerBuilt)("pipeline: fixture → analyzer → IR → OpenAPI 3.1", () => {
  if (!analyzerBuilt) {
    it("skipped — run `pnpm build:analyzers` to enable", () => {});
    return;
  }

  it("finds the fixture projects", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // A golden whose fixture was removed (or stopped being analyzable) would
  // otherwise linger and pass silently.
  it("has no orphaned golden files", () => {
    const orphans = fixtureDirs
      .filter((name) => existsSync(join(fixturesDir, name, GOLDEN_FILE)))
      .filter((name) => !fixtures.includes(name));
    expect(orphans).toEqual([]);
  });

  it.each(fixtures)("%s", async (fixture) => {
    const projectPath = join(fixturesDir, fixture);
    const detected = detectAspnetProject(projectPath);
    expect(detected).not.toBeNull();
    if (detected === null) return;

    // runAnalyzer validates the analyzer's stdout through the zod IR schema.
    const result = await runAnalyzer({ projectPath, repoRootHint: repoRoot });

    // An empty or degraded result would still yield a "valid" document — fail
    // loudly instead. Only diagnostics-* fixtures may warn (that is their job);
    // a warning elsewhere usually means the fixture failed to restore/compile.
    expect(result.routes.length, `${fixture}: analyzer found no routes`).toBeGreaterThan(0);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors, `${fixture}: analyzer reported errors`).toEqual([]);
    if (!fixture.startsWith("diagnostics-")) {
      expect(result.errors, `${fixture}: unexpected diagnostics`).toEqual([]);
    }

    const info = readProjectInfoFor(detected);
    const doc = toOpenApi(result, {
      title: info.title,
      version: info.version,
      ...(info.description !== undefined ? { description: info.description } : {}),
    });

    await expect(normalizeEol(toYaml(doc))).toMatchFileSnapshot(goldenPath(fixture));

    const validation = await new Validator().validate(doc as unknown as Record<string, unknown>);
    expect(validation.valid, `${fixture}: ${JSON.stringify(validation.errors, null, 2)}`).toBe(
      true,
    );

    expect(checkOpenApiInvariants(doc)).toEqual([]);
  });
});
