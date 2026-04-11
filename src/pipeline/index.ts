import "../parser/modules";
import { and, eq, lt, or } from "drizzle-orm";
import { analysisQueue, QueueItem } from "../queue/analysisQueue";
import type { WorkflowRunPayload } from "../api/webhookHandler";
import { processAnalysis } from "./processAnalysis";
import { logger } from "../utils/logger";
import { db } from "../db/connection";
import { webhookEvents } from "../db/schema";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_STALE_MS = 60 * 60 * 1000; // 1 hour — stop replaying after this

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
      const maxStaleThreshold = new Date(Date.now() - MAX_STALE_MS);
      const replayable: typeof staleEvents = [];

      for (const event of staleEvents) {
        if (
          event.processed === "processing" &&
          event.createdAt < maxStaleThreshold
        ) {
          logger.warn(
            { eventId: event.id, createdAt: event.createdAt },
            "Marking stale event as error — exceeded max replay age"
          );
          await db
            .update(webhookEvents)
            .set({ processed: "error", processedAt: new Date(), errorMessage: "Exceeded max replay age (1 hour)" })
            .where(eq(webhookEvents.id, event.id));
        } else {
          replayable.push(event);
        }
      }

      if (replayable.length > 0) {
        logger.info(
          { count: replayable.length },
          "Replaying stale webhook events from previous run"
        );

        for (const event of replayable) {
          const payload = event.payload as WorkflowRunPayload;
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
    }
  } catch (err) {
    logger.warn({ err }, "Failed to replay stale webhook events — skipping");
  }
}
