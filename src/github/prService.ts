import crypto from "crypto";
import path from "path";
import { Octokit } from "@octokit/rest";

import { config } from "../config";
import { logger } from "../utils/logger";
import type { ParseResult } from "../parser/types";

const log = logger.child({ module: "prService" });

export interface RepoPermissions {
  canPush: boolean;
  archived: boolean;
}

export interface CreatePRParams {
  owner: string;
  repo: string;
  token: string;
  spec: string;
  parseResult: ParseResult;
  commitSha: string;
  version: string;
  docsOutput?: string;
}

export interface CreatePRResult {
  prNumber: number;
  prUrl: string;
}

/**
 * Check whether the authenticated user (the GitHub App installation) has
 * push permission on the repository and whether the repo is archived.
 */
export async function checkRepoPermissions(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string
): Promise<RepoPermissions> {
  const { data } = await octokit.rest.repos.get({ owner, repo });

  return {
    canPush: data.permissions?.push ?? false,
    archived: data.archived ?? false,
  };
}

/**
 * Pad a number to at least two digits.
 */
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Generate the branch name using the current timestamp.
 */
function buildBranchName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const nonce = crypto.randomBytes(2).toString("hex");
  return `astronaut/docs-${stamp}-${nonce}`;
}

/**
 * Build the markdown table of discovered endpoints.
 */
function buildEndpointTable(parseResult: ParseResult): string {
  if (parseResult.routes.length === 0) {
    return "_No endpoints discovered._";
  }

  const header = "| Method | Path |\n|--------|------|";
  const rows = parseResult.routes.map(
    (r) => `| ${r.method} | ${r.path} |`
  );
  return [header, ...rows].join("\n");
}

/**
 * Build the parse-warnings section, if any.
 */
function buildWarningsSection(parseResult: ParseResult): string {
  if (parseResult.errors.length === 0) {
    return "";
  }

  const lines = parseResult.errors.map(
    (e) => `- \`${e.file}\` \u2014 ${e.reason}`
  );
  return `\n### Parse Warnings\n${lines.join("\n")}\n`;
}

/**
 * Build the full PR body.
 */
function buildPRBody(
  version: string,
  parseResult: ParseResult
): string {
  const endpointCount = parseResult.routes.length;
  const table = buildEndpointTable(parseResult);
  const warnings = buildWarningsSection(parseResult);

  return [
    "## API Documentation Generated",
    "",
    `**Version:** ${version}`,
    `**Endpoints found:** ${endpointCount}`,
    "",
    table,
    warnings,
    "---",
    "> Your source code has been deleted from our servers immediately after analysis.",
  ].join("\n");
}

/**
 * Create a pull request containing the generated OpenAPI spec.
 *
 * The full workflow:
 * 1. Authenticate as the installation
 * 2. Resolve version from tags or short SHA
 * 3. Create a new branch from the default branch HEAD
 * 4. Create or update the spec file on that branch
 * 5. Open a pull request back to the default branch
 */
export async function createPR(params: CreatePRParams): Promise<CreatePRResult> {
  const { owner, repo, token, spec, parseResult, commitSha, version, docsOutput } = params;

  log.info({ owner, repo, commitSha, version }, "Starting PR creation");

  const octokit = new Octokit({
    auth: token,
    userAgent: config.userAgent,
  });

  // 2. Get default branch and its latest commit SHA
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;

  const { data: refData } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const baseSha = refData.object.sha;

  // 4. Create a new branch
  const branchName = buildBranchName();
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
  log.info({ branchName, baseSha }, "Created branch");

  // 5. Create or update the spec file
  const filePath = docsOutput || "docs/openapi.yaml";
  const normalizedPath = path.posix.normalize(filePath);
  if (
    normalizedPath.startsWith("..") ||
    path.isAbsolute(normalizedPath) ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath.includes(":")
  ) {
    throw new Error(`Unsafe file path rejected: ${filePath}`);
  }
  const contentBase64 = Buffer.from(spec, "utf8").toString("base64");
  const commitMessage = "docs: update API documentation (ASTronaut)";

  // Check if the file already exists on the new branch (inherited from default)
  let existingFileSha: string | undefined;
  try {
    const { data: existingFile } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: normalizedPath,
      ref: branchName,
    });
    // getContent returns either a file object or an array (directory listing).
    if (!Array.isArray(existingFile) && existingFile.type === "file") {
      existingFileSha = existingFile.sha;
    }
  } catch (err: unknown) {
    // 404 means the file does not exist yet, which is fine.
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      throw err;
    }
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: normalizedPath,
    message: commitMessage,
    content: contentBase64,
    branch: branchName,
    ...(existingFileSha ? { sha: existingFileSha } : {}),
  });
  log.info({ filePath: normalizedPath, branchName }, "Committed spec file");

  // 6. Open the pull request
  const prTitle = `docs: API documentation update \u2014 ${version}`;
  const prBody = buildPRBody(version, parseResult);

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: prTitle,
    body: prBody,
    head: branchName,
    base: defaultBranch,
  });

  log.info(
    { prNumber: pr.number, prUrl: pr.html_url },
    "Pull request created"
  );

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
  };
}
