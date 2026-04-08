#!/usr/bin/env node

// Silence Pino logger in CLI mode — must be set before any import that loads config
process.env.LOG_LEVEL = "silent";

import { parseArgs } from "node:util";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Register all parser modules before anything else
import "../parser/modules";

import { detectAndParse, getAllFrameworkModules } from "../parser/registry";
import { generateOpenApiSpec } from "../generator/openApiGenerator";
import { loadAutodocConfig } from "../config/autodocConfig";
import type { AutoDocConfig } from "../config/autodocConfig";

function printHelp(): void {
  const modules = getAllFrameworkModules();
  const ids = modules.map((m) => m.id).join(" | ");

  console.log(`
ASTronaut — Generate OpenAPI specs from source code via AST analysis

Usage:
  astronaut analyze [path] [options]

Arguments:
  path                    Repository path (default: current directory)

Options:
  -f, --framework <name>  Force framework: ${ids}
  -o, --output <file>     Write spec to file (default: stdout)
      --format <type>     Output format: yaml | json (default: yaml)
  -h, --help              Show this help message
  -v, --version           Show version
`);
}

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getSpecVersion(repoPath: string): string {
  try {
    const tag = execSync("git describe --tags --abbrev=0", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return tag.replace(/^v/, "");
  } catch {
    try {
      const sha = execSync("git rev-parse --short HEAD", {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return sha || "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      framework: { type: "string", short: "f" },
      output: { type: "string", short: "o" },
      format: { type: "string", default: "yaml" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(`astronaut v${getVersion()}`);
    process.exit(0);
  }

  // Resolve repo path
  const repoPath = path.resolve(positionals[0] || ".");

  if (!fs.existsSync(repoPath)) {
    console.error(`Error: Path not found: ${repoPath}`);
    process.exit(1);
  }

  if (!fs.statSync(repoPath).isDirectory()) {
    console.error(`Error: Not a directory: ${repoPath}`);
    process.exit(1);
  }

  const startTime = Date.now();

  // Build config from .autodoc.yml + CLI args
  const autodocConfig: AutoDocConfig = (await loadAutodocConfig(repoPath)) || {};
  if (values.framework) {
    autodocConfig.framework = values.framework as AutoDocConfig["framework"];
  }

  // Detect and parse
  let parseResult;
  try {
    parseResult = await detectAndParse(repoPath, autodocConfig);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // No routes found
  if (parseResult.routes.length === 0) {
    console.error("Error: No routes found in the codebase");
    if (parseResult.errors.length > 0) {
      console.error("\nParse errors:");
      for (const e of parseResult.errors) {
        console.error(`  ${e.file}: ${e.reason}`);
      }
    }
    process.exit(1);
  }

  // Generate spec
  const format = values.format === "json" ? "json" : "yaml";
  const specVersion = getSpecVersion(repoPath);
  const title = path.basename(repoPath);

  const spec = generateOpenApiSpec(parseResult, { title, version: specVersion });

  // Format output
  let output: string;
  if (format === "json") {
    // The generator returns YAML — parse and re-serialize as JSON
    const yaml = await import("js-yaml");
    const parsed = yaml.load(spec);
    output = JSON.stringify(parsed, null, 2);
  } else {
    output = spec;
  }

  // Write output
  if (values.output) {
    const outputPath = path.resolve(values.output);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, output, "utf-8");
    console.log(`Spec written to ${outputPath}`);
  } else {
    process.stdout.write(output);
  }

  // Summary to stderr
  const durationMs = Date.now() - startTime;
  console.error(`\nRoutes: ${parseResult.routes.length}`);
  if (parseResult.errors.length > 0) {
    console.error(`Warnings: ${parseResult.errors.length}`);
    for (const e of parseResult.errors) {
      console.error(`  ${e.file}: ${e.reason}`);
    }
  }
  console.error(`Format: ${format.toUpperCase()}`);
  console.error(`Duration: ${durationMs}ms`);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
