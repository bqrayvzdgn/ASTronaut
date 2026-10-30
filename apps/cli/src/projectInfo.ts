import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DetectedProject } from "./detect.js";

export interface ProjectInfo {
  title: string;
  version: string;
  description?: string;
}

export function readProjectInfoFor(detected: DetectedProject): ProjectInfo {
  if (detected.kind === "solution") {
    const title = basename(detected.path).replace(/\.(sln|slnx)$/i, "");
    return { title: title || "API", version: "0.0.0" };
  }
  return readProjectInfo(detected.path);
}

export function readProjectInfo(csprojPath: string): ProjectInfo {
  let xml = "";
  try {
    xml = readFileSync(csprojPath, "utf8");
  } catch {
    return defaultInfo(csprojPath);
  }
  const assemblyName = extractTag(xml, "AssemblyName");
  const version = extractTag(xml, "Version");
  const description = extractTag(xml, "Description");

  const fallback = defaultInfo(csprojPath);
  const info: ProjectInfo = {
    title: assemblyName ?? fallback.title,
    version: version ?? fallback.version,
  };
  if (description) info.description = description;
  return info;
}

function defaultInfo(csprojPath: string): ProjectInfo {
  const fileBase = basename(csprojPath, ".csproj");
  const folder = basename(dirname(csprojPath));
  return {
    title: fileBase || folder || "API",
    version: "0.0.0",
  };
}

function extractTag(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>\\s*([^<\\s][^<]*?)\\s*</${tag}>`);
  const match = pattern.exec(xml);
  if (!match || !match[1]) return undefined;
  return match[1].trim();
}
