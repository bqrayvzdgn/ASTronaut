import os from "os";
import path from "path";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

import { config } from "../config";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const log = logger.child({ module: "repoManager" });

/**
 * GitHub owner and repo names may only contain alphanumerics, hyphens,
 * underscores, and dots. Reject anything else to prevent argument injection.
 */
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
}

/**
 * Sensitive file patterns that must be removed from any cloned repository
 * before analysis begins. Only exact names and simple prefix/suffix globs
 * are matched -- we intentionally avoid broad wildcard matching.
 */
const SENSITIVE_EXACT_NAMES: ReadonlySet<string> = new Set([
  ".env",
  "credentials.json",
  "service-account.json",
  "appsettings.Development.json",
  "appsettings.Local.json",
]);

const SENSITIVE_PREFIXES: readonly string[] = [".env."];

const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
]);

/**
 * Clone a GitHub repository at depth 1 using the supplied installation
 * access token. Returns the absolute path to the cloned repo.
 */
export async function cloneRepo(
  owner: string,
  repo: string,
  installationToken: string
): Promise<string> {
  assertSafeName(owner, "owner");
  assertSafeName(repo, "repo");

  const timestamp = Date.now();
  const dirName = `astronaut_${owner}_${repo}_${timestamp}`;
  const repoPath = path.join(os.tmpdir(), dirName);

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  log.info({ owner, repo, repoPath }, "Cloning repository");

  try {
    const base64Token = Buffer.from(`x-access-token:${installationToken}`).toString("base64");
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        cloneUrl,
        repoPath,
      ],
      {
        timeout: config.timeouts.cloneMs,
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${base64Token}`,
        },
      }
    );
  } catch (err: unknown) {
    // Scrub the token from any error messages before re-throwing
    const sanitized =
      err instanceof Error
        ? new Error(
            err.message.replaceAll(installationToken, "***"),
          )
        : err;
    log.error({ owner, repo, err: sanitized }, "Git clone failed");
    throw sanitized;
  }

  log.info({ owner, repo, repoPath }, "Clone complete");
  return repoPath;
}

/**
 * Walk a directory tree recursively and return all file paths.
 */
async function walkDir(dir: string, depth: number = 0): Promise<string[]> {
  if (depth > 50) {
    log.warn({ dir, depth }, "Maximum directory depth exceeded — skipping");
    return [];
  }

  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip symlinks entirely — they can bypass sensitive file checks
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      // Skip .git directory entirely
      if (entry.name === ".git") continue;
      const nested = await walkDir(fullPath, depth + 1);
      results.push(...nested);
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Check whether a file name matches one of the sensitive patterns.
 */
function isSensitiveFile(fileName: string): boolean {
  // Exact name match
  if (SENSITIVE_EXACT_NAMES.has(fileName)) {
    return true;
  }

  // Prefix match (e.g. ".env.production", ".env.local")
  for (const prefix of SENSITIVE_PREFIXES) {
    if (fileName.startsWith(prefix)) {
      return true;
    }
  }

  // Extension match (e.g. "server.key", "cert.pem")
  const ext = path.extname(fileName).toLowerCase();
  if (ext && SENSITIVE_EXTENSIONS.has(ext)) {
    return true;
  }

  return false;
}

/**
 * Remove sensitive files (secrets, private keys, credentials) from the
 * cloned repository before source analysis. Only removes files matching
 * the predefined patterns.
 */
export async function removeSensitiveFiles(repoPath: string): Promise<void> {
  log.info({ repoPath }, "Scanning for sensitive files");

  const allFiles = await walkDir(repoPath);
  let removedCount = 0;

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);
    if (isSensitiveFile(fileName)) {
      await fs.unlink(filePath);
      removedCount++;
      log.info(
        { file: path.relative(repoPath, filePath) },
        "Removed sensitive file"
      );
    }
  }

  log.info({ repoPath, removedCount }, "Sensitive file cleanup complete");
}

/**
 * Remove the cloned repository directory and all of its contents.
 */
export async function cleanup(repoPath: string): Promise<void> {
  log.info({ repoPath }, "Cleaning up cloned repository");
  await fs.rm(repoPath, { recursive: true, force: true });
  log.info({ repoPath }, "Cleanup complete");
}
