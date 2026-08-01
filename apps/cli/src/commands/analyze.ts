import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ParseResult } from "@astronaut/core";
import { toJson, toOpenApi, toYaml } from "@astronaut/generator";
import {
  AnalyzerCrashedError,
  AnalyzerNotFoundError,
  AnalyzerOutputError,
  runAnalyzer,
} from "@astronaut/parser-bridge";
import { detectAspnetProject } from "../detect.js";
import { readProjectInfoFor } from "../projectInfo.js";
import { ui } from "../ui.js";

export interface AnalyzeOptions {
  output?: string;
  json: boolean;
  strict: boolean;
  title?: string;
  version?: string;
}

export async function analyzeCommand(rawPath: string, options: AnalyzeOptions): Promise<number> {
  const projectPath = resolve(rawPath);
  ui.info(`Analyzing ${projectPath}`);

  const detected = detectAspnetProject(projectPath);
  if (!detected) {
    ui.error(
      `No supported project detected at ${projectPath}. Expected a directory containing a .csproj or .sln, or such a file directly.`,
    );
    return 1;
  }
  ui.dim(`Detected: ${detected.framework} ${detected.kind} (${detected.path})`);

  let result: ParseResult;
  try {
    result = await runAnalyzer({ projectPath, repoRootHint: process.cwd() });
  } catch (err) {
    handleAnalyzerError(err);
    return err instanceof AnalyzerNotFoundError ? 2 : 1;
  }

  reportDiagnostics(result);
  if (options.strict && result.errors.some((e) => e.severity === "error")) {
    ui.error(`Strict mode: ${result.errors.length} diagnostic(s) reported.`);
    return 1;
  }
  if (result.routes.length === 0) {
    ui.error("Analyzer found 0 routes. Nothing to emit.");
    return 1;
  }

  const projectInfo = readProjectInfoFor(detected);
  const doc = toOpenApi(result, {
    title: options.title ?? projectInfo.title,
    version: options.version ?? projectInfo.version,
    ...(projectInfo.description !== undefined ? { description: projectInfo.description } : {}),
  });
  const serialized = options.json ? toJson(doc) : toYaml(doc);

  if (options.output) {
    const outPath = resolve(options.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized, "utf8");
    ui.success(`Wrote ${result.routes.length} route(s) → ${outPath}`);
  } else {
    process.stdout.write(serialized);
    ui.success(`Emitted ${result.routes.length} route(s)`);
  }
  return 0;
}

function reportDiagnostics(result: ParseResult): void {
  for (const err of result.errors) {
    const line = `${err.file}:${err.line} ${err.code ?? ""} ${err.message}`.trim();
    if (err.severity === "error") ui.error(line);
    else ui.warn(line);
  }
}

function handleAnalyzerError(err: unknown): void {
  if (err instanceof AnalyzerNotFoundError) {
    ui.error(err.message);
    return;
  }
  if (err instanceof AnalyzerCrashedError) {
    ui.error(err.message);
    return;
  }
  if (err instanceof AnalyzerOutputError) {
    ui.error(err.message);
    return;
  }
  ui.error(`Unexpected error: ${(err as Error).message}`);
}
