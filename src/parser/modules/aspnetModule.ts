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

  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          await walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith(".csproj")) {
        results.push(fullPath);
      }
    }
  }

  await walk(repoPath);
  return results;
}

registerFramework(aspnetModule);
