import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

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

  const solution = findFirst(inputPath, (name) => isSolution(name));
  if (solution) return { framework: "aspnet", kind: "solution", path: solution };

  const csproj = findFirst(inputPath, (name) => name.toLowerCase().endsWith(".csproj"));
  return csproj ? { framework: "aspnet", kind: "project", path: csproj } : null;
}

function isSolution(name: string): boolean {
  const lower = name.toLowerCase();
  return SOLUTION_EXTS.some((ext) => lower.endsWith(ext));
}

// Breadth-ish walk returning the first file whose name matches, skipping
// build-output and dependency directories.
function findFirst(dir: string, match: (name: string) => boolean): string | null {
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
        return full;
      }
    }
  }
  return null;
}
