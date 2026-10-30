import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalyzerNotFoundError } from "./errors.js";

const ANALYZER_REL_PATH = "analyzers/dotnet/dist/AsTronaut.Analyzer.dll";

export function resolveDotnetAnalyzer(opts: { repoRootHint?: string } = {}): string {
  const envOverride = process.env.ASTRONAUT_DOTNET_ANALYZER;
  if (envOverride && envOverride.length > 0) {
    if (!existsSync(envOverride)) {
      throw new AnalyzerNotFoundError(envOverride);
    }
    return envOverride;
  }

  const candidates: string[] = [];
  if (opts.repoRootHint) {
    candidates.push(resolve(opts.repoRootHint, ANALYZER_REL_PATH));
  }
  candidates.push(...defaultRepoRootSearchPaths());

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new AnalyzerNotFoundError(candidates[candidates.length - 1] ?? ANALYZER_REL_PATH);
}

function defaultRepoRootSearchPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromBuild = resolve(here, "..", "..", "..", "..", ANALYZER_REL_PATH);
  const fromSrc = resolve(here, "..", "..", "..", ANALYZER_REL_PATH);
  return [fromBuild, fromSrc];
}
