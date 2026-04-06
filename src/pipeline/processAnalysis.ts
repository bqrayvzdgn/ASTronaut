import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import { QueueItem } from "../queue/analysisQueue";
import { createChildLogger } from "../utils/logger";
import { config } from "../config";
import { getValidToken } from "../github/appAuth";
import { checkRepoPermissions, createPR } from "../github/prService";
import { cloneRepo, removeSensitiveFiles, cleanup } from "../github/repoManager";
import { loadAutodocConfig } from "../config/autodocConfig";
import { detectFramework, Framework } from "../detector/frameworkDetector";
import { generateOpenApiSpec } from "../generator/openApiGenerator";
import { db } from "../db/connection";
import { analyses, installations, repos, webhookEvents } from "../db/schema";
import type { ParseResult } from "../parser/types";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId)
  );
}

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
    token = await getValidToken(installationId);
  } catch (err) {
    log.error({ err }, "Failed to obtain installation token");
    throw err;
  }

  const octokit = new Octokit({ auth: token, userAgent: "ASTronaut/1.0" });

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
    repoPath = await cloneRepo(owner, repo, token);
    await removeSensitiveFiles(repoPath);

    // Load optional config
    const autodocConfig = loadAutodocConfig(repoPath);

    // Detect framework
    const framework = await detectFramework(repoPath, autodocConfig);
    log.info({ framework }, "Framework detected");

    // Parse based on framework (with timeout)
    const parseResult = await withTimeout(
      parseByFramework(framework, repoPath),
      config.timeouts.parseMs,
      "parseByFramework"
    );
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

    // Create PR (with timeout)
    const docsOutput = autodocConfig?.docsOutput;
    const prResult = await withTimeout(
      createPR({
        owner,
        repo,
        installationId,
        spec,
        parseResult,
        commitSha,
        version,
        docsOutput,
      }),
      config.timeouts.prMs,
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
              isActive: "true",
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
    // DB save failure should not crash the pipeline
    // The PR was already created at this point
  }
}
