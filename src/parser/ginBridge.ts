import { config } from "../config";
import { ParseResult } from "./types";
import { runExternalAnalyzer } from "./externalBridge";

export async function parseGin(repoPath: string): Promise<ParseResult> {
  const analyzerPath = config.ginAnalyzerPath;

  return runExternalAnalyzer({
    command: analyzerPath,
    args: [repoPath],
    label: "Gin",
    timeoutMs: config.timeouts.parseMs,
    repoPath,
  });
}
