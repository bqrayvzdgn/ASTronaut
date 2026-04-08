import fsPromises from "fs/promises";
import path from "path";
import { registerFramework } from "../registry";
import type { FrameworkModule } from "../types";

const expressModule: FrameworkModule = {
  id: "express",
  name: "Express.js",
  languages: ["javascript", "typescript"],

  async detect(repoPath: string): Promise<number> {
    const packageJsonPath = path.join(repoPath, "package.json");
    try {
      await fsPromises.access(packageJsonPath);
    } catch {
      return 0;
    }

    try {
      const raw = await fsPromises.readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(raw);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      return allDeps["express"] ? 1 : 0;
    } catch {
      return 0;
    }
  },

  async parse(repoPath: string) {
    const { parseExpressRoutes } = await import("../expressParser");
    return parseExpressRoutes(repoPath);
  },
};

registerFramework(expressModule);
