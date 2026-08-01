import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { ui } from "./ui.js";

export interface DetectedProject {
  framework: "aspnet";
  /** "solution" when the entry point is a .sln/.slnx, else a single project. */
  kind: "project" | "solution";
  /** Path to the .csproj or .sln/.slnx that will be handed to the analyzer. */
  path: string;
}

const SOLUTION_EXTS = [".sln", ".slnx"];

// Resolves the input into the file the analyzer should open. A solution takes
// precedence over a bare .csproj so multi-project surface is captured. If the
// input itself is a .csproj/.sln, it's returned directly. Returns null when
// nothing analyzable is found — caller decides how to surface it.
export function detectAspnetProject(inputPath: string): DetectedProject | null {
  if (!existsSync(inputPath)) return null;
  const stat = statSync(inputPath);
  if (stat.isFile()) {
    if (isSolution(inputPath)) return { framework: "aspnet", kind: "solution", path: inputPath };
    if (inputPath.toLowerCase().endsWith(".csproj")) {
      return { framework: "aspnet", kind: "project", path: inputPath };
    }
    return null;
  }

  const solutions = findMatches(inputPath, (name) => isSolution(name));
  const solution = solutions[0];
  if (solution) {
    if (solutions.length > 1) {
      ui.warn(`Multiple solution files found; using ${solution}`);
    }
    return { framework: "aspnet", kind: "solution", path: solution };
  }

  const csprojs = findMatches(inputPath, (name) => name.toLowerCase().endsWith(".csproj"));
  const csproj = csprojs[0];
  if (csproj && csprojs.length > 1) {
    ui.warn(`Multiple .csproj files found; using ${csproj}`);
  }
  return csproj ? { framework: "aspnet", kind: "project", path: csproj } : null;
}

function isSolution(name: string): boolean {
  const lower = name.toLowerCase();
  return SOLUTION_EXTS.some((ext) => lower.endsWith(ext));
}

// Walks the tree collecting every file whose name matches, skipping
// build-output and dependency directories. Results are sorted by path so the
// caller's pick is deterministic regardless of filesystem traversal order.
function findMatches(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "bin" || entry === "obj" || entry === "node_modules") continue;
      const full = join(current, entry);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (match(entry)) {
        const segments = full.split(sep);
        if (segments.some((p) => p === "bin" || p === "obj")) continue;
        found.push(full);
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}
