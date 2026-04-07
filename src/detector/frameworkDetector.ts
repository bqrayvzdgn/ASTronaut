import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { logger } from "../utils/logger";

export enum Framework {
  EXPRESS = "express",
  NESTJS = "nestjs",
  NEXTJS = "nextjs",
  ASPNET_CONTROLLER = "aspnet-controller",
  ASPNET_MINIMAL = "aspnet-minimal",
  ASPNET_BOTH = "aspnet-both",
}

export interface AutoDocConfig {
  framework?: string;
  docsOutput?: string;
}

export async function detectFramework(
  repoPath: string,
  config?: AutoDocConfig | null
): Promise<Framework> {
  // 1. Config override
  if (config?.framework) {
    const mapping: Record<string, Framework> = {
      express: Framework.EXPRESS,
      nestjs: Framework.NESTJS,
      nextjs: Framework.NEXTJS,
      aspnet: Framework.ASPNET_CONTROLLER,
      "aspnet-controller": Framework.ASPNET_CONTROLLER,
      "aspnet-minimal": Framework.ASPNET_MINIMAL,
    };
    const fw = mapping[config.framework];
    if (fw) {
      logger.info({ framework: fw }, "Framework from config override");
      return fw;
    }
  }

  // 2. Check package.json (Node.js project)
  const packageJsonPath = path.join(repoPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      if (allDeps["@nestjs/core"]) {
        logger.info("Detected NestJS framework");
        return Framework.NESTJS;
      }
      if (allDeps["next"]) {
        logger.info("Detected Next.js framework");
        return Framework.NEXTJS;
      }
      if (allDeps["express"]) {
        logger.info("Detected Express framework");
        return Framework.EXPRESS;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to parse package.json");
    }
  }

  // 3. Check .csproj files (ASP.NET project)
  const csprojFiles = await findCsprojFiles(repoPath);
  if (csprojFiles.length > 0) {
    let hasAspNet = false;
    for (const csproj of csprojFiles) {
      const content = fs.readFileSync(csproj, "utf-8");
      if (content.includes("Microsoft.AspNetCore")) {
        hasAspNet = true;
        break;
      }
    }

    if (hasAspNet) {
      const hasControllers = await checkForControllers(repoPath);
      const hasMinimalApi = await checkForMinimalApi(repoPath);

      if (hasControllers && hasMinimalApi) {
        logger.info("Detected ASP.NET Core (Controller + Minimal API)");
        return Framework.ASPNET_BOTH;
      }
      if (hasMinimalApi) {
        logger.info("Detected ASP.NET Core Minimal API");
        return Framework.ASPNET_MINIMAL;
      }
      logger.info("Detected ASP.NET Core Controller-based");
      return Framework.ASPNET_CONTROLLER;
    }
  }

  throw new Error("Desteklenen framework bulunamadi");
}

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
      !entry.parentPath.includes("node_modules")
    ) {
      results.push(path.join(entry.parentPath, entry.name));
    }
  }
  return results;
}

async function checkForControllers(repoPath: string): Promise<boolean> {
  // Check for Controllers/ directory or [ApiController] attribute
  const controllersDir = path.join(repoPath, "Controllers");
  if (fs.existsSync(controllersDir)) return true;

  // Search for [ApiController] in .cs files
  return searchInCsFiles(repoPath, "[ApiController]");
}

async function checkForMinimalApi(repoPath: string): Promise<boolean> {
  // Check Program.cs or Startup.cs for MapGet, MapPost, etc.
  const candidates = ["Program.cs", "Startup.cs"];
  for (const candidate of candidates) {
    const filePath = path.join(repoPath, candidate);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      if (
        content.includes("MapGet") ||
        content.includes("MapPost") ||
        content.includes("MapPut") ||
        content.includes("MapDelete")
      ) {
        return true;
      }
    }
  }
  // Fallback: search all .cs files for Minimal API patterns
  return (
    (await searchInCsFiles(repoPath, "MapGet")) ||
    (await searchInCsFiles(repoPath, "MapPost")) ||
    (await searchInCsFiles(repoPath, "MapPut")) ||
    (await searchInCsFiles(repoPath, "MapDelete"))
  );
}

async function searchInCsFiles(
  repoPath: string,
  searchText: string
): Promise<boolean> {
  const entries = await fsPromises.readdir(repoPath, {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of entries) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".cs") &&
      !entry.parentPath.includes("node_modules") &&
      !entry.parentPath.includes("obj") &&
      !entry.parentPath.includes("bin")
    ) {
      const content = await fsPromises.readFile(
        path.join(entry.parentPath, entry.name),
        "utf-8"
      );
      if (content.includes(searchText)) return true;
    }
  }
  return false;
}
