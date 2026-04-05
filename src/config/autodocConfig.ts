import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { logger } from "../utils/logger";

export interface AutoDocConfig {
  framework?: "express" | "nestjs" | "aspnet" | "nextjs";
  docsOutput?: string;
}

function isPathSafe(p: string): boolean {
  const normalized = path.posix.normalize(p);
  return (
    !normalized.startsWith("..") &&
    !path.isAbsolute(normalized) &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    !p.includes(":")
  );
}

export function loadAutodocConfig(repoPath: string): AutoDocConfig | null {
  const configPath = path.join(repoPath, ".autodoc.yml");

  if (!fs.existsSync(configPath)) {
    logger.info("No .autodoc.yml found, using defaults");
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(content) as Record<string, unknown>;

    const config: AutoDocConfig = {};

    if (
      typeof parsed.framework === "string" &&
      ["express", "nestjs", "aspnet", "nextjs"].includes(parsed.framework)
    ) {
      config.framework = parsed.framework as AutoDocConfig["framework"];
    }

    if (typeof parsed.docs_output === "string") {
      if (!isPathSafe(parsed.docs_output)) {
        logger.warn({ docsOutput: parsed.docs_output }, "Rejected unsafe docs_output path");
      } else {
        config.docsOutput = path.posix.normalize(parsed.docs_output);
      }
    }

    logger.info({ config }, "Loaded .autodoc.yml");
    return config;
  } catch (err) {
    logger.warn({ err }, "Failed to parse .autodoc.yml, using defaults");
    return null;
  }
}
