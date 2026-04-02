import { Request, Response } from "express";
import crypto from "crypto";

import { config } from "../config";
import { logger } from "../utils/logger";
import { checkRateLimit } from "../utils/rateLimiter";
import { analysisQueue, QueueItem } from "../queue/analysisQueue";
import { db } from "../db/connection";
import { webhookEvents } from "../db/schema";

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
  const rawBody: Buffer | undefined = (req as any).rawBody;

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

  // 2. Event filtering
  const eventType = req.headers["x-github-event"] as string | undefined;
  const payload = req.body;

  if (eventType !== "workflow_run") {
    log.debug({ eventType }, "Ignoring non-workflow_run event");
    res.status(200).json({ ignored: true, reason: "not a workflow_run event" });
    return;
  }

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

  // 3. Rate limit check
  const repoFullName: string = payload.repository.full_name;

  if (!checkRateLimit(repoFullName)) {
    log.warn({ repo: repoFullName }, "Rate limit exceeded");
    res.status(429).json({ error: "Rate limit exceeded for this repository" });
    return;
  }

  // 4. Save webhook event to DB
  try {
    await db.insert(webhookEvents).values({
      eventType: eventType,
      action: payload.action,
      repoFullName,
      payload,
      processed: "pending",
    });
  } catch (err) {
    log.error({ err, repo: repoFullName }, "Failed to save webhook event to DB");
    // Continue processing even if DB write fails — the analysis is more important
  }

  // 5. Enqueue analysis
  const item: QueueItem = {
    id: `${repoFullName}-${Date.now()}`,
    repoFullName,
    payload,
    addedAt: Date.now(),
  };

  analysisQueue.enqueue(item);

  log.info({ repo: repoFullName, queueItemId: item.id }, "Analysis enqueued");
  res.status(202).json({ queued: true, id: item.id });
}
