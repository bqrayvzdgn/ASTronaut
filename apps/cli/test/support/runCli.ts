import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/cli/test/support/ → repo root is four levels up.
export const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
export const fixturesDir = join(repoRoot, "fixtures", "dotnet");
export const cliBin = join(repoRoot, "apps", "cli", "dist", "bin.js");

// Committed expectation next to each fixture; regenerate deliberately with
// `pnpm test:e2e -u` and review the diff.
export const GOLDEN_FILE = "expected.openapi.yaml";

export function fixturePath(name: string, ...segments: string[]): string {
  return join(fixturesDir, name, ...segments);
}

export function goldenPath(fixture: string): string {
  return fixturePath(fixture, GOLDEN_FILE);
}

// Goldens are committed with LF (.gitattributes); this guards a CRLF checkout.
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the built CLI (apps/cli/dist/bin.js) as a child process and resolves with
// its exit code and captured streams. Never rejects on a non-zero exit — exit
// codes are part of the contract under test.
export function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  if (!existsSync(cliBin)) {
    throw new Error(`CLI is not built (${cliBin}). Run \`pnpm build\` first.`);
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliBin, ...args],
      {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}
