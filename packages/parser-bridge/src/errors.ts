export class AnalyzerNotFoundError extends Error {
  constructor(public readonly searched: string) {
    super(`Analyzer binary not found at ${searched}. Run \`pnpm build:analyzers\` first.`);
    this.name = "AnalyzerNotFoundError";
  }
}

export class AnalyzerCrashedError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderrTail: string,
  ) {
    super(`Analyzer exited with code ${exitCode}.\n--- stderr (tail) ---\n${stderrTail}`);
    this.name = "AnalyzerCrashedError";
  }
}

export class AnalyzerOutputError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnalyzerOutputError";
  }
}
