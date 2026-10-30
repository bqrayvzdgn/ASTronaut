import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiDocument } from "@astronaut/generator";
import { toYaml } from "@astronaut/generator";
import { resolveDotnetAnalyzer } from "@astronaut/parser-bridge";
import { describe, expect, it } from "vitest";
import { fixturePath, goldenPath, normalizeEol, repoRoot, runCli } from "./support/runCli.js";

// The CLI contract as a user experiences it: exit codes, what lands on stdout
// versus stderr, and the options — running the real apps/cli/dist/bin.js.
// Exit codes: 0 success · 1 user/analysis error · 2 analyzer binary missing.

let analyzerBuilt = false;
try {
  analyzerBuilt = existsSync(resolveDotnetAnalyzer({ repoRootHint: repoRoot }));
} catch {
  analyzerBuilt = false;
}

const basic = fixturePath("controllers-basic");

function golden(fixture: string): string {
  return normalizeEol(readFileSync(goldenPath(fixture), "utf8"));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astronaut-cli-"));
}

describe.skipIf(!analyzerBuilt)("cli: analyze contract", () => {
  if (!analyzerBuilt) {
    it("skipped — run `pnpm build:analyzers` to enable", () => {});
    return;
  }

  it("writes YAML to -o (creating parent dirs, spaces allowed) and keeps stdout empty", async () => {
    const out = join(tempDir(), "nested dir", "spec.yaml");
    const res = await runCli(["analyze", basic, "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe("");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("controllers-basic"));
  });

  it("streams the same YAML to stdout when -o is omitted, with nothing else on stdout", async () => {
    const res = await runCli(["analyze", basic]);
    expect(res.code, res.stderr).toBe(0);
    expect(normalizeEol(res.stdout)).toBe(golden("controllers-basic"));
  });

  it("--json emits the same document as JSON", async () => {
    const res = await runCli(["analyze", basic, "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(res.stdout) as OpenApiDocument;
    expect(doc.openapi).toBe("3.1.0");
    // Re-serialising the parsed JSON must reproduce the YAML golden exactly.
    expect(toYaml(doc)).toBe(golden("controllers-basic"));
  });

  it("--json -o writes JSON to the file", async () => {
    const out = join(tempDir(), "spec.json");
    const res = await runCli(["analyze", basic, "--json", "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(out, "utf8")) as OpenApiDocument;
    expect(toYaml(doc)).toBe(golden("controllers-basic"));
  });

  it("--title and --version-tag override the csproj-derived info", async () => {
    const res = await runCli([
      "analyze",
      basic,
      "--json",
      "--title",
      "Custom API",
      "--version-tag",
      "9.9.9",
    ]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(res.stdout) as OpenApiDocument;
    expect(doc.info).toEqual({ title: "Custom API", version: "9.9.9" });
  });

  it("exits 1 with a clear message when the path holds no project", async () => {
    const res = await runCli(["analyze", join(repoRoot, "does-not-exist")]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No supported project detected");
  });

  it("exits 2 when the analyzer binary cannot be found", async () => {
    const res = await runCli(["analyze", basic], {
      env: { ASTRONAUT_DOTNET_ANALYZER: join(tempDir(), "missing", "AsTronaut.Analyzer.dll") },
    });
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Analyzer binary not found");
  });

  it("exits 1 when the project yields no routes", async () => {
    const classlib = fixturePath("solution-multi-project", "Contracts", "Contracts.csproj");
    const res = await runCli(["analyze", classlib]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("0 routes");
  });

  it("reports W004 for a skipped open-generic controller and still succeeds", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli(["analyze", fixturePath("diagnostics-open-generic"), "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("W004");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("diagnostics-open-generic"));
  });

  it("--strict passes when only warnings are reported", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli([
      "analyze",
      fixturePath("diagnostics-open-generic"),
      "--strict",
      "-o",
      out,
    ]);
    expect(res.code, res.stderr).toBe(0);
  });

  it("picks the first project deterministically (W007) when a directory holds several", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli(["analyze", fixturePath("diagnostics-multi-csproj"), "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("Multiple .csproj files found");
    expect(res.stderr).toContain("W007");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("diagnostics-multi-csproj"));
  });

  it("exits 1 and emits no document when the solution cannot be loaded", async () => {
    const res = await runCli(["analyze", fixturePath("diagnostics-load-failure")]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
