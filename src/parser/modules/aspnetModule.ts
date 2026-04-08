import fsPromises from "fs/promises";
import path from "path";
import { registerFramework } from "../registry";
import type { FrameworkModule } from "../types";

const aspnetModule: FrameworkModule = {
  id: "aspnet",
  name: "ASP.NET Core",
  languages: ["csharp"],

  async detect(repoPath: string): Promise<number> {
    const csprojFiles = await findCsprojFiles(repoPath);
    if (csprojFiles.length === 0) return 0;

    for (const csproj of csprojFiles) {
      const content = await fsPromises.readFile(csproj, "utf-8");
      if (content.includes("Microsoft.AspNetCore")) {
        return 1;
      }
    }

    return 0;
  },

  async parse(repoPath: string) {
    const { parseDotnet } = await import("../dotnetBridge");
    return parseDotnet(repoPath);
  },
};

async function findCsprojFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fsPromises.readdir(repoPath, {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of entries) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".csproj") &&
      !(entry.parentPath ?? (entry as any).path).includes("node_modules")
    ) {
      results.push(path.join((entry.parentPath ?? (entry as any).path), entry.name));
    }
  }
  return results;
}

registerFramework(aspnetModule);
