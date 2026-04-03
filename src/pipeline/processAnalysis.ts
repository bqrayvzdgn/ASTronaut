import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import { QueueItem } from "../queue/analysisQueue";
import { createChildLogger } from "../utils/logger";
import { getValidToken } from "../github/appAuth";
import { checkRepoPermissions, createPR } from "../github/prService";
import { cloneRepo, removeSensitiveFiles, cleanup } from "../github/repoManager";
import { loadAutodocConfig } from "../config/autodocConfig";
import { detectFramework, Framework } from "../detector/frameworkDetector";
import { generateOpenApiSpec } from "../generator/openApiGenerator";
import { db } from "../db/connection";
import { analyses, repos, webhookEvents } from "../db/schema";
import type { ParseResult } from "../parser/types";

async function updateWebhookStatus(
  webhookEventId: number | undefined,
  status: "processing" | "done" | "skipped" | "error",
  errorMessage?: string
): Promise<void> {
  if (!webhookEventId) return;
  try {
    await db
      .update(webhookEvents)
      .set({
        processed: status,
        processedAt: new Date(),
        ...(errorMessage ? { errorMessage } : {}),
      })
      .where(eq(webhookEvents.id, webhookEventId));
  } catch {
    // Status tracking failure should not crash the pipeline
  }
}

export async function processAnalysis(item: QueueItem): Promise<void> {
  const payload = item.payload as any;
  const webhookEventId = item.webhookEventId;

  const owner: string = payload.repository.owner.login;
  const repo: string = payload.repository.name;
  const installationId: number = payload.installation.id;
  const commitSha: string = payload.workflow_run.head_sha;

  const log = createChildLogger({ owner, repo, commitSha });
  const startTime = Date.now();

  log.info("Starting analysis pipeline");
  await updateWebhookStatus(webhookEventId, "processing");

  // 1. Permission check
  let token: string;
  try {
    token = await getValidToken(installationId);
  } catch (err) {
    log.error({ err }, "Failed to obtain installation token");
    throw err;
  }

  const octokit = new Octokit({ auth: token, userAgent: "AutoDocAPI/1.0" });

  const permissions = await checkRepoPermissions(octokit, owner, repo);
  if (!permissions.canPush || permissions.archived) {
    const reason = permissions.archived
      ? "repository is archived"
      : "no push permission";
    log.warn({ reason }, "Skipping analysis due to permission restrictions");

    await updateWebhookStatus(webhookEventId, "skipped");
    await saveAnalysis({
      owner,
      repo,
      commitSha,
      status: "failed",
      errors: [{ reason: `permission_denied: ${reason}` }],
      durationMs: Date.now() - startTime,
    });
    return;
  }

  // 2. Clone, analyze, and create PR
  let repoPath: string | null = null;
  try {
    repoPath = await cloneRepo(owner, repo, token);
    await removeSensitiveFiles(repoPath);

    // Load optional config
    const autodocConfig = loadAutodocConfig(repoPath);

    // Detect framework
    const framework = await detectFramework(repoPath, autodocConfig);
    log.info({ framework }, "Framework detected");

    // Parse based on framework
    const parseResult = await parseByFramework(framework, repoPath);
    log.info(
      { routeCount: parseResult.routes.length, errorCount: parseResult.errors.length },
      "Parsing complete"
    );

    // Resolve version from tags or short SHA
    const version = await resolveVersion(octokit, owner, repo, commitSha);
    log.info({ version }, "Resolved version");

    // Generate OpenAPI spec
    const spec = generateOpenApiSpec(parseResult, {
      title: repo,
      version,
    });

    // Create PR
    const docsOutput = autodocConfig?.docsOutput;
    const prResult = await createPR({
      owner,
      repo,
      installationId,
      spec,
      parseResult,
      commitSha,
      docsOutput,
    });

    log.info({ prNumber: prResult.prNumber, prUrl: prResult.prUrl }, "PR created");

    // Save success to DB
    const status = parseResult.errors.length > 0 ? "partial" : "success";
    await saveAnalysis({
      owner,
      repo,
      commitSha,
      tag: version,
      spec,
      status,
      errors: parseResult.errors.length > 0 ? parseResult.errors : undefined,
      endpointCount: parseResult.routes.length,
      prNumber: prResult.prNumber,
      prUrl: prResult.prUrl,
      durationMs: Date.now() - startTime,
    });

    await updateWebhookStatus(webhookEventId, "done");
  } catch (err) {
    log.error({ err }, "Analysis pipeline failed");

    await updateWebhookStatus(
      webhookEventId,
      "error",
      err instanceof Error ? err.message : String(err)
    );

    await saveAnalysis({
      owner,
      repo,
      commitSha,
      status: "failed",
      errors: [{ reason: err instanceof Error ? err.message : String(err) }],
      durationMs: Date.now() - startTime,
    });

    throw err;
  } finally {
    if (repoPath) {
      try {
        await cleanup(repoPath);
      } catch (cleanupErr) {
        log.warn({ err: cleanupErr }, "Cleanup failed");
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log.info({ durationMs }, "Analysis pipeline completed");
}

async function parseByFramework(
  framework: Framework,
  repoPath: string
): Promise<ParseResult> {
  switch (framework) {
    case Framework.EXPRESS: {
      const { parseExpressRoutes } = await import("../parser/expressParser");
      return parseExpressRoutes(repoPath);
    }
    case Framework.NESTJS: {
      const { parseNestRoutes } = await import("../parser/nestParser");
      return parseNestRoutes(repoPath);
    }
    case Framework.NEXTJS: {
      const { parseNextRoutes } = await import("../parser/nextParser");
      return parseNextRoutes(repoPath);
    }
    case Framework.ASPNET_CONTROLLER:
    case Framework.ASPNET_MINIMAL:
    case Framework.ASPNET_BOTH: {
      const { parseDotnet } = await import("../parser/dotnetBridge");
      return parseDotnet(repoPath);
    }
    default: {
      throw new Error(`Unsupported framework: ${framework}`);
    }
  }
}

async function resolveVersion(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  commitSha: string
): Promise<string> {
  try {
    const { data: tags } = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });

    const matchingTag = tags.find((t) => t.commit.sha === commitSha);
    if (matchingTag) {
      return matchingTag.name.replace(/^v/, "");
    }
  } catch (err) {
    // Tag fetch failure is non-fatal; fall back to short SHA
  }

  return commitSha.substring(0, 7);
}

interface SaveAnalysisParams {
  owner: string;
  repo: string;
  commitSha: string;
  tag?: string;
  spec?: string;
  status: "success" | "partial" | "failed";
  errors?: unknown;
  endpointCount?: number;
  prNumber?: number;
  prUrl?: string;
  durationMs: number;
}

async function saveAnalysis(params: SaveAnalysisParams): Promise<void> {
  try {
    // Look up repo ID from the repos table
    const [repoRow] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.repoFullName, `${params.owner}/${params.repo}`))
      .limit(1);

    if (!repoRow) {
      // If we don't have the repo registered yet, we can't save the analysis
      // This is a soft failure — the PR was still created
      return;
    }

    await db.insert(analyses).values({
      repoId: repoRow.id,
      commitSha: params.commitSha,
      tag: params.tag ?? null,
      spec: params.spec ?? "",
      status: params.status,
      errors: params.errors ?? null,
      endpointCount: params.endpointCount ?? null,
      prNumber: params.prNumber ?? null,
      prUrl: params.prUrl ?? null,
      durationMs: params.durationMs,
    });
  } catch (err) {
    // DB save failure should not crash the pipeline
    // The PR was already created at this point
  }
}
