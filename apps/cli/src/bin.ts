#!/usr/bin/env node
import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze.js";
import { ui } from "./ui.js";

const program = new Command();

program
  .name("astronaut")
  .description("Generate OpenAPI 3.1 from your source code (pure AST, no AI)")
  .version("0.0.0");

program
  .command("analyze")
  .description("Analyse a project and emit OpenAPI 3.1")
  .argument("<path>", "Path to a project directory or .csproj file")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .option("--json", "Emit JSON instead of YAML", false)
  .option("--strict", "Exit non-zero on any analyzer error diagnostic", false)
  .option("--title <title>", "Override the spec title")
  .option("--version-tag <version>", "Override the spec info.version")
  .action(async (path: string, opts: Record<string, unknown>) => {
    const analyzeOpts: import("./commands/analyze.js").AnalyzeOptions = {
      json: Boolean(opts.json),
      strict: Boolean(opts.strict),
    };
    if (typeof opts.output === "string") analyzeOpts.output = opts.output;
    if (typeof opts.title === "string") analyzeOpts.title = opts.title;
    if (typeof opts.versionTag === "string") analyzeOpts.version = opts.versionTag;

    const exitCode = await analyzeCommand(path, analyzeOpts);
    process.exit(exitCode);
  });

program.parseAsync(process.argv).catch((err) => {
  ui.error(`Fatal: ${(err as Error).message}`);
  process.exit(2);
});
