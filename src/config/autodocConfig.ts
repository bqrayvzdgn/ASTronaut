import fsPromises from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { logger } from "../utils/logger";

export interface AutoDocConfig {
  framework?: string;
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

export async function loadAutodocConfig(repoPath: string): Promise<AutoDocConfig | null> {
  const configPath = path.join(repoPath, ".autodoc.yml");

  try {
    await fsPromises.access(configPath);
  } catch {
    logger.info("No .autodoc.yml found, using defaults");
    return null;
  }

  try {
    const content = await fsPromises.readFile(configPath, "utf-8");
    const raw = yaml.load(content);

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      logger.warn("Invalid .autodoc.yml format — expected an object, using defaults");
      return null;
    }

    const parsed = raw as Record<string, unknown>;
    const config: AutoDocConfig = {};

    if (typeof parsed.framework === "string" && parsed.framework.trim()) {
      config.framework = parsed.framework.trim();
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
