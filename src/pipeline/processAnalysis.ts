import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import { QueueItem } from "../queue/analysisQueue";
import { createChildLogger, logger } from "../utils/logger";
import { config } from "../config";
import { getValidToken } from "../github/appAuth";
import { checkRepoPermissions, createPR } from "../github/prService";
import { cloneRepo, removeSensitiveFiles, cleanup } from "../github/repoManager";
import { loadAutodocConfig } from "../config/autodocConfig";
import { detectAndParse } from "../parser/registry";
import { generateOpenApiSpec } from "../generator/openApiGenerator";
import { db } from "../db/connection";
import { analyses, installations, repos, webhookEvents } from "../db/schema";

import { withTimeout } from "../utils/withTimeout";
import { githubApiRetry, gitCloneRetry } from "../utils/retryPolicy";
import type { WorkflowRunPayload } from "../api/webhookHandler";

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
  } catch (err) {
    logger.warn({ err, webhookEventId }, "Failed to update webhook status");
  }
}

export async function processAnalysis(item: QueueItem): Promise<void> {
  const payload = item.payload as WorkflowRunPayload;
  const webhookEventId = item.webhookEventId;

  const owner: string | undefined = payload?.repository?.owner?.login;
  const repo: string | undefined = payload?.repository?.name;
  const installationId: number | undefined = payload?.installation?.id;
  const commitSha: string | undefined = payload?.workflow_run?.head_sha;

  if (!owner || !repo || !installationId || !commitSha) {
    const log = createChildLogger({ owner, repo, commitSha });
    log.error(
      { payloadKeys: Object.keys(payload ?? {}) },
      "Malformed webhook payload: missing required fields"
    );
    await updateWebhookStatus(webhookEventId, "error", "Malformed payload");
    return;
  }

  const log = createChildLogger({ owner, repo, commitSha });
  const startTime = Date.now();

  log.info("Starting analysis pipeline");
  await updateWebhookStatus(webhookEventId, "processing");

  // 1. Permission check
  let token: string;
  try {
    token = await githubApiRetry(
      () => withTimeout(getValidToken(installationId), config.timeouts.prMs, "getValidToken"),
      "getValidToken"
    );
  } catch (err) {
    log.error({ err }, "Failed to obtain installation token");
    throw err;
  }

  const octokit = new Octokit({ auth: token, userAgent: config.userAgent });

  const permissions = await githubApiRetry(
    () => withTimeout(checkRepoPermissions(octokit, owner, repo), config.timeouts.prMs, "checkRepoPermissions"),
    "checkRepoPermissions"
  );
  if (!permissions.canPush || permissions.archived) {
    const reason = permissions.archived
      ? "repository is archived"
      : "no push permission";
    log.warn({ reason }, "Skipping analysis due to permission restrictions");

    await updateWebhookStatus(webhookEventId, "skipped");
    await saveAnalysis({
      owner,
      repo,
      installationId,
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
    repoPath = await gitCloneRetry(
      () => cloneRepo(owner, repo, token),
      "cloneRepo"
    );
    await removeSensitiveFiles(repoPath);

    // Load optional config
    const autodocConfig = await loadAutodocConfig(repoPath);

    // Detect framework and parse routes
    const parseResult = await withTimeout(
      detectAndParse(repoPath, autodocConfig),
      config.timeouts.parseMs,
      "detectAndParse"
    );
    log.info(
      { routeCount: parseResult.routes.length, errorCount: parseResult.errors.length },
      "Parsing complete"
    );

    // Skip PR creation if no routes were found
    if (parseResult.routes.length === 0) {
      log.warn("No routes found — skipping PR creation");
      await saveAnalysis({
        owner,
        repo,
        installationId,
        commitSha,
        status: "failed",
        errors: parseResult.errors.length > 0
          ? parseResult.errors
          : [{ reason: "No routes found in the codebase" }],
        durationMs: Date.now() - startTime,
      });
      await updateWebhookStatus(webhookEventId, "done");
      return;
    }

    // Resolve version from tags or short SHA
    const version = await githubApiRetry(
      () => withTimeout(resolveVersion(octokit, owner, repo, commitSha), config.timeouts.prMs, "resolveVersion"),
      "resolveVersion"
    );
    log.info({ version }, "Resolved version");

    // Generate OpenAPI spec
    const spec = generateOpenApiSpec(parseResult, {
      title: repo,
      version,
    });

    // Create PR (with timeout + retry)
    const docsOutput = autodocConfig?.docsOutput;
    const prResult = await githubApiRetry(
      () => withTimeout(
        createPR({
          owner,
          repo,
          token,
          spec,
          parseResult,
          commitSha,
          version,
          docsOutput,
        }),
        config.timeouts.prMs,
        "createPR"
      ),
      "createPR"
    );

    log.info({ prNumber: prResult.prNumber, prUrl: prResult.prUrl }, "PR created");

    // Save success to DB
    const status = parseResult.errors.length > 0 ? "partial" : "success";
    await saveAnalysis({
      owner,
      repo,
      installationId,
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
      installationId,
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
}

async function resolveVersion(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  commitSha: string
): Promise<string> {
  const MAX_TAG_PAGES = 5;
  try {
    let page = 1;
    const perPage = 100;
    while (page <= MAX_TAG_PAGES) {
      const { data: tags } = await octokit.rest.repos.listTags({
        owner,
        repo,
        per_page: perPage,
        page,
      });

      const matchingTag = tags.find((t) => t.commit.sha === commitSha);
      if (matchingTag) {
        return matchingTag.name.replace(/^v/, "");
      }

      if (tags.length < perPage) break;
      page++;
    }
  } catch (err) {
    logger.debug({ err, owner, repo }, "Tag fetch failed, using commit SHA");
  }

  return commitSha.substring(0, 7);
}

interface SaveAnalysisParams {
  owner: string;
  repo: string;
  installationId?: number;
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
    let [repoRow] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.repoFullName, `${params.owner}/${params.repo}`))
      .limit(1);

    if (!repoRow) {
      // Repo not registered yet — try to create it if we know the installation
      if (params.installationId) {
        const [instRow] = await db
          .select({ id: installations.id })
          .from(installations)
          .where(eq(installations.githubInstallationId, params.installationId))
          .limit(1);

        if (instRow) {
          const [newRepo] = await db
            .insert(repos)
            .values({
              installationId: instRow.id,
              repoName: params.repo,
              repoFullName: `${params.owner}/${params.repo}`,
              isActive: true,
            })
            .returning({ id: repos.id });

          repoRow = newRepo;
        }
      }

      if (!repoRow) {
        // Truly no installation or repo — soft failure, PR was still created
        return;
      }
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
    logger.warn({ err, commitSha: params.commitSha }, "Failed to save analysis to database");
  }
}
