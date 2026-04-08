import { Request, Response } from "express";
import crypto from "crypto";
import { eq, and, ne, sql } from "drizzle-orm";

import { config } from "../config";
import { logger } from "../utils/logger";
import { checkRateLimit } from "../utils/rateLimiter";
import { analysisQueue, QueueItem } from "../queue/analysisQueue";
import { db } from "../db/connection";
import { webhookEvents, installations, repos } from "../db/schema";

// ---------------------------------------------------------------------------
// Webhook payload types
// ---------------------------------------------------------------------------

export interface WorkflowRunPayload {
  action?: string;
  repository?: { owner?: { login?: string }; name?: string; full_name?: string };
  installation?: { id?: number };
  workflow_run?: { id?: number; head_sha?: string; conclusion?: string };
}

export interface InstallationPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  repositories?: Array<{ full_name: string; name: string }>;
}

export interface InstallationRepositoriesPayload {
  action?: string;
  installation?: { id?: number };
  repositories_added?: Array<{ full_name: string; name: string }>;
  repositories_removed?: Array<{ full_name: string; name: string }>;
}

const log = logger.child({ module: "webhookHandler" });

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  const expected = Buffer.from(
    "sha256=" +
      crypto
        .createHmac("sha256", config.github.webhookSecret)
        .update(rawBody)
        .digest("hex"),
    "utf8"
  );
  const provided = Buffer.from(signatureHeader, "utf8");

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, provided);
}

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  // 1. Verify signature
  const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody: Buffer | undefined = req.rawBody;

  if (!signatureHeader || !rawBody) {
    log.warn("Missing signature header or raw body");
    res.status(401).json({ error: "Missing signature" });
    return;
  }

  if (!verifySignature(rawBody, signatureHeader)) {
    log.warn("Webhook signature verification failed");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // 2. Dispatch by event type
  const eventType = req.headers["x-github-event"] as string | undefined;
  const payload = req.body;

  switch (eventType) {
    case "installation":
      await handleInstallationEvent(payload as InstallationPayload, res);
      return;

    case "installation_repositories":
      await handleInstallationRepositoriesEvent(payload as InstallationRepositoriesPayload, res);
      return;

    case "workflow_run":
      await handleWorkflowRunEvent(eventType, payload as WorkflowRunPayload, res);
      return;

    default:
      log.debug({ eventType }, "Ignoring unhandled event type");
      res.status(200).json({ ignored: true, reason: `unhandled event: ${eventType}` });
      return;
  }
}

/**
 * Handle installation.created and installation.deleted events.
 * Creates or removes installation and repo rows in the database.
 */
async function handleInstallationEvent(payload: InstallationPayload, res: Response): Promise<void> {
  const action = payload.action;
  const installationId: number | undefined = payload.installation?.id;
  const owner: string | undefined = payload.installation?.account?.login;

  if (!installationId || !owner) {
    log.warn({ action }, "Malformed installation event payload");
    res.status(400).json({ error: "Malformed payload" });
    return;
  }

  if (!checkRateLimit(`installation:${installationId}`)) {
    log.warn({ installationId }, "Rate limit exceeded for installation event");
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  if (action === "created") {
    log.info({ installationId, owner }, "Processing installation.created");

    try {
      // Insert installation row
      const [instRow] = await db
        .insert(installations)
        .values({
          githubInstallationId: installationId,
          owner,
        })
        .onConflictDoNothing({ target: installations.githubInstallationId })
        .returning({ id: installations.id });

      // If onConflictDoNothing returned nothing, look up existing row
      let instDbId: number;
      if (instRow) {
        instDbId = instRow.id;
      } else {
        const [existing] = await db
          .select({ id: installations.id })
          .from(installations)
          .where(eq(installations.githubInstallationId, installationId))
          .limit(1);

        if (!existing) {
          log.error({ installationId }, "Installation row not found after conflict");
          res.status(500).json({ error: "Failed to process installation event" });
          return;
        }
        instDbId = existing.id;
      }

      // Insert repos
      const repositories: Array<{ name: string; full_name: string }> =
        payload.repositories ?? [];

      if (repositories.length > 0) {
        await db
          .insert(repos)
          .values(
            repositories.map((r) => ({
              installationId: instDbId,
              repoName: r.name,
              repoFullName: r.full_name,
              isActive: true,
            }))
          )
          .onConflictDoNothing();
      }

      log.info(
        { installationId, owner, repoCount: repositories.length },
        "Installation created with repos"
      );
      res.status(200).json({ processed: true, action: "installation.created" });
    } catch (err) {
      log.error({ err, installationId }, "Failed to process installation.created");
      res.status(500).json({ error: "Failed to process installation event" });
    }
    return;
  }

  if (action === "deleted") {
    log.info({ installationId, owner }, "Processing installation.deleted");

    try {
      // Look up installation to get internal ID for FK cascade
      const [instRow] = await db
        .select({ id: installations.id })
        .from(installations)
        .where(eq(installations.githubInstallationId, installationId))
        .limit(1);

      if (instRow) {
        // Delete repos first (FK constraint)
        await db.delete(repos).where(eq(repos.installationId, instRow.id));
        // Delete installation
        await db.delete(installations).where(eq(installations.id, instRow.id));
      }

      log.info({ installationId }, "Installation deleted");
      res.status(200).json({ processed: true, action: "installation.deleted" });
    } catch (err) {
      log.error({ err, installationId }, "Failed to process installation.deleted");
      res.status(500).json({ error: "Failed to process installation event" });
    }
    return;
  }

  // Other actions (e.g. suspend, unsuspend) — ignore
  log.debug({ action }, "Ignoring installation action");
  res.status(200).json({ ignored: true, reason: `unhandled installation action: ${action}` });
}

/**
 * Handle installation_repositories.added and installation_repositories.removed events.
 */
async function handleInstallationRepositoriesEvent(
  payload: InstallationRepositoriesPayload,
  res: Response
): Promise<void> {
  const action = payload.action;
  const installationId: number | undefined = payload.installation?.id;

  if (!installationId) {
    log.warn({ action }, "Malformed installation_repositories event payload");
    res.status(400).json({ error: "Malformed payload" });
    return;
  }

  if (!checkRateLimit(`installation:${installationId}`)) {
    log.warn({ installationId }, "Rate limit exceeded for repository event");
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  try {
    // Look up installation internal ID
    const [instRow] = await db
      .select({ id: installations.id })
      .from(installations)
      .where(eq(installations.githubInstallationId, installationId))
      .limit(1);

    if (!instRow) {
      log.warn(
        { installationId },
        "Received repository event for unknown installation"
      );
      res.status(200).json({ ignored: true, reason: "unknown installation" });
      return;
    }

    if (action === "added") {
      const added: Array<{ name: string; full_name: string }> =
        payload.repositories_added ?? [];

      if (added.length > 0) {
        await db
          .insert(repos)
          .values(
            added.map((r) => ({
              installationId: instRow.id,
              repoName: r.name,
              repoFullName: r.full_name,
              isActive: true,
            }))
          )
          .onConflictDoNothing();
      }

      log.info({ installationId, count: added.length }, "Repositories added");
    }

    if (action === "removed") {
      const removed: Array<{ full_name: string }> =
        payload.repositories_removed ?? [];

      for (const r of removed) {
        await db.delete(repos).where(eq(repos.repoFullName, r.full_name));
      }

      log.info({ installationId, count: removed.length }, "Repositories removed");
    }

    res.status(200).json({ processed: true, action: `repositories.${action}` });
  } catch (err) {
    log.error({ err, installationId }, "Failed to process repository event");
    res.status(500).json({ error: "Failed to process repository event" });
  }
}

/**
 * Handle workflow_run.completed events — the original analysis trigger.
 */
async function handleWorkflowRunEvent(
  eventType: string,
  payload: WorkflowRunPayload,
  res: Response
): Promise<void> {
  if (payload.action !== "completed") {
    log.debug({ action: payload.action }, "Ignoring non-completed action");
    res.status(200).json({ ignored: true, reason: "action is not completed" });
    return;
  }

  if (payload.workflow_run?.conclusion !== "success") {
    log.debug(
      { conclusion: payload.workflow_run?.conclusion },
      "Ignoring non-success conclusion"
    );
    res.status(200).json({ ignored: true, reason: "conclusion is not success" });
    return;
  }

  // Validate required payload fields
  const repoFullName: string | undefined = payload.repository?.full_name;
  if (!repoFullName || typeof repoFullName !== "string") {
    log.warn("Missing repository.full_name in workflow_run payload");
    res.status(400).json({ error: "Malformed payload" });
    return;
  }

  // Rate limit check
  if (!checkRateLimit(repoFullName)) {
    log.warn({ repo: repoFullName }, "Rate limit exceeded");
    res.status(429).json({ error: "Rate limit exceeded for this repository" });
    return;
  }

  // Idempotency: skip if this workflow_run was already processed
  const workflowRunId = payload.workflow_run?.id;
  if (workflowRunId) {
    try {
      const [existing] = await db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.repoFullName, repoFullName),
            eq(webhookEvents.eventType, "workflow_run"),
            ne(webhookEvents.processed, "error"),
            sql`${webhookEvents.payload}->'workflow_run'->>'id' = ${String(workflowRunId)}`
          )
        )
        .limit(1);

      if (existing) {
        log.info({ repo: repoFullName, workflowRunId }, "Duplicate webhook — already processed");
        res.status(200).json({ ignored: true, reason: "already processed" });
        return;
      }
    } catch (err) {
      log.warn({ err, repo: repoFullName }, "Failed idempotency check — continuing");
    }
  }

  // Save webhook event to DB and capture ID for status tracking
  let webhookEventId: number | undefined;
  try {
    const [inserted] = await db
      .insert(webhookEvents)
      .values({
        eventType: eventType,
        action: payload.action,
        repoFullName,
        payload,
        processed: "pending",
      })
      .returning({ id: webhookEvents.id });

    webhookEventId = inserted?.id;
  } catch (err) {
    log.error({ err, repo: repoFullName }, "Failed to save webhook event to DB");
    // Continue processing even if DB write fails — the analysis is more important
  }

  // Enqueue analysis
  const item: QueueItem = {
    id: `${repoFullName}-${Date.now()}`,
    repoFullName,
    payload,
    addedAt: Date.now(),
    webhookEventId,
  };

  const enqueued = analysisQueue.enqueue(item);

  if (!enqueued) {
    log.warn({ repo: repoFullName }, "Queue at capacity — rejecting request");
    res.status(503).json({ error: "Server busy, try again later" });
    return;
  }

  log.info({ repo: repoFullName, queueItemId: item.id }, "Analysis enqueued");
  res.status(202).json({ queued: true, id: item.id });
}
