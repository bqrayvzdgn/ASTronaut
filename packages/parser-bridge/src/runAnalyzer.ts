import { spawn } from "node:child_process";
import type { ParseResult } from "@astronaut/core";
import { IRValidationError, parseIR } from "@astronaut/core";
import { AnalyzerCrashedError, AnalyzerOutputError } from "./errors.js";
import { resolveDotnetAnalyzer } from "./resolveAnalyzer.js";

export interface RunAnalyzerOptions {
  /** Path to a directory or `.csproj` file. */
  projectPath: string;
  /** Override the resolved analyzer binary path. */
  analyzerPath?: string;
  /** Repo root used to resolve the default analyzer search location. */
  repoRootHint?: string;
  /** Kill the analyzer if it runs longer than this many milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_TAIL_BYTES = 4_000;

export async function runAnalyzer(options: RunAnalyzerOptions): Promise<ParseResult> {
  const analyzer =
    options.analyzerPath ??
    resolveDotnetAnalyzer(options.repoRootHint ? { repoRootHint: options.repoRootHint } : {});
  const args = ["exec", analyzer, options.projectPath];
  if (options.repoRootHint) {
    args.push("--cwd", options.repoRootHint);
  }

  const { stdout, stderrTail, exitCode } = await spawnCollect(
    "dotnet",
    args,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (exitCode !== 0) {
    throw new AnalyzerCrashedError(exitCode, stderrTail);
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new AnalyzerOutputError(
      `Analyzer exited cleanly but produced no JSON on stdout.\n--- stderr (tail) ---\n${stderrTail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new AnalyzerOutputError(
      `Analyzer stdout is not valid JSON: ${(err as Error).message}`,
      err,
    );
  }

  try {
    return parseIR(parsed);
  } catch (err) {
    if (err instanceof IRValidationError) {
      throw new AnalyzerOutputError(
        `Analyzer output did not match the IR schema: ${err.message}`,
        err,
      );
    }
    throw err;
  }
}

interface SpawnResult {
  stdout: string;
  stderrTail: string;
  exitCode: number;
}

function spawnCollect(cmd: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      // A missing executable surfaces as ENOENT here. For `dotnet` specifically
      // this means the .NET SDK isn't on PATH — turn the raw spawn error into a
      // friendly, actionable message instead of a generic "Unexpected error".
      if (cmd === "dotnet" && (err as NodeJS.ErrnoException).code === "ENOENT") {
        const friendly = new Error(
          ".NET SDK not found on PATH. Install .NET 8+ and ensure `dotnet` is available.",
        );
        friendly.name = "DotnetNotFoundError";
        rejectPromise(friendly);
        return;
      }
      rejectPromise(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrAll = Buffer.concat(stderrChunks);
      const stderrTail = stderrAll
        .subarray(Math.max(0, stderrAll.length - STDERR_TAIL_BYTES))
        .toString("utf8");
      const exitCode = timedOut ? 124 : (code ?? 1);
      resolvePromise({ stdout, stderrTail, exitCode });
    });
  });
}
