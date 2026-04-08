import fsPromises from "fs/promises";
import path from "path";
import { registerFramework } from "../registry";
import type { FrameworkModule } from "../types";

const ginModule: FrameworkModule = {
  id: "gin",
  name: "Gin",
  languages: ["go"],

  async detect(repoPath: string): Promise<number> {
    const goModPath = path.join(repoPath, "go.mod");
    try {
      await fsPromises.access(goModPath);
    } catch {
      return 0;
    }

    try {
      const content = await fsPromises.readFile(goModPath, "utf-8");
      return content.includes("github.com/gin-gonic/gin") ? 1 : 0;
    } catch {
      return 0;
    }
  },

  async parse(repoPath: string) {
    const { parseGin } = await import("../ginBridge");
    return parseGin(repoPath);
  },
};

registerFramework(ginModule);
