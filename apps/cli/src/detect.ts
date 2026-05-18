import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export interface DetectedProject {
  framework: "aspnet";
  csprojPath: string;
}

// Walks the input directory looking for the first .csproj outside bin/ and obj/.
// If the input itself is a .csproj, returns it directly. Returns null when the
// directory exists but contains no .csproj — caller decides how to surface it.
export function detectAspnetProject(inputPath: string): DetectedProject | null {
  if (!existsSync(inputPath)) return null;
  const stat = statSync(inputPath);
  if (stat.isFile()) {
    return inputPath.toLowerCase().endsWith(".csproj")
      ? { framework: "aspnet", csprojPath: inputPath }
      : null;
  }
  const found = findCsproj(inputPath);
  return found ? { framework: "aspnet", csprojPath: found } : null;
}

function findCsproj(dir: string): string | null {
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
      if (entry.toLowerCase().endsWith(".csproj")) {
        // Skip csproj files nested inside bin/ or obj/ at any depth.
        const segments = full.split(sep);
        if (segments.some((p) => p === "bin" || p === "obj")) continue;
        return full;
      }
    }
  }
  return null;
}
