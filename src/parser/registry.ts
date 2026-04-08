import type { FrameworkModule, ParseResult } from "./types";
import type { AutoDocConfig } from "../config/autodocConfig";
import { logger } from "../utils/logger";

const modules = new Map<string, FrameworkModule>();

export function registerFramework(mod: FrameworkModule): void {
  if (modules.has(mod.id)) {
    throw new Error(`Framework module "${mod.id}" is already registered`);
  }
  modules.set(mod.id, mod);
  logger.info({ id: mod.id, name: mod.name }, "Registered framework module");
}

export function getFrameworkModule(id: string): FrameworkModule | undefined {
  return modules.get(id);
}

export function getAllFrameworkModules(): FrameworkModule[] {
  return Array.from(modules.values());
}

/**
 * Detect which framework module should handle this repo, then parse it.
 * Respects .autodoc.yml override when present.
 */
export async function detectAndParse(
  repoPath: string,
  autodocConfig?: AutoDocConfig | null
): Promise<ParseResult> {
  // 1. Config override — look up module by id directly
  if (autodocConfig?.framework) {
    const mod = modules.get(autodocConfig.framework);
    if (mod) {
      logger.info({ framework: mod.id }, "Framework from config override");
      return mod.parse(repoPath);
    }
    logger.warn(
      { framework: autodocConfig.framework },
      "Config override framework not found in registry, falling back to detection"
    );
  }

  // 2. Run detect() on all registered modules, pick highest confidence
  let bestModule: FrameworkModule | null = null;
  let bestScore = 0;

  for (const mod of modules.values()) {
    const score = await mod.detect(repoPath);
    if (score > bestScore) {
      bestScore = score;
      bestModule = mod;
    }
  }

  if (!bestModule || bestScore === 0) {
    throw new Error("No supported framework detected");
  }

  logger.info({ framework: bestModule.id, confidence: bestScore }, "Framework detected");
  return bestModule.parse(repoPath);
}
