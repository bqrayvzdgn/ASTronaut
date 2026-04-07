import { and, eq, lt, or } from "drizzle-orm";
import { analysisQueue, QueueItem } from "../queue/analysisQueue";
import { processAnalysis } from "./processAnalysis";
import { logger } from "../utils/logger";
import { db } from "../db/connection";
import { webhookEvents } from "../db/schema";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function initializePipeline(): Promise<void> {
  analysisQueue.setProcessor(processAnalysis);

  // Replay pending/stale webhook events from previous runs
  try {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    const staleEvents = await db
      .select()
      .from(webhookEvents)
      .where(
        or(
          eq(webhookEvents.processed, "pending"),
          and(
            eq(webhookEvents.processed, "processing"),
            lt(webhookEvents.createdAt, staleThreshold)
          )
        )
      );

    if (staleEvents.length > 0) {
      logger.info(
        { count: staleEvents.length },
        "Replaying stale webhook events from previous run"
      );

      for (const event of staleEvents) {
        const payload = event.payload as any;
        const repoFullName =
          event.repoFullName || payload?.repository?.full_name;
        if (!repoFullName) continue;

        const item: QueueItem = {
          id: `replay-${event.id}-${Date.now()}`,
          repoFullName,
          payload,
          addedAt: Date.now(),
          webhookEventId: event.id,
        };

        analysisQueue.enqueue(item);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to replay stale webhook events — skipping");
  }
}
