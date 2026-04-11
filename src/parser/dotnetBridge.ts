import { config } from "../config";
import { ParseResult } from "./types";
import { runExternalAnalyzer } from "./externalBridge";

export async function parseDotnet(repoPath: string): Promise<ParseResult> {
  const analyzerDllPath = config.dotnetAnalyzerPath;

  return runExternalAnalyzer({
    command: "dotnet",
    args: [analyzerDllPath, repoPath, String(Math.floor(config.timeouts.restoreMs / 1000))],
    label: ".NET",
    timeoutMs: config.timeouts.parseMs,
    repoPath,
  });
}
