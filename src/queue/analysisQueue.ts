import { config } from "../config";
import { logger } from "../utils/logger";

export interface QueueItem {
  id: string;
  repoFullName: string;
  payload: unknown;
  addedAt: number;
  webhookEventId?: number;
}

type ProcessFn = (item: QueueItem) => Promise<void>;

class AnalysisQueue {
  private queue: QueueItem[] = [];
  private activeJobs = new Map<string, Promise<void>>();
  private processFn: ProcessFn | null = null;
  private maxConcurrent: number;

  constructor() {
    this.maxConcurrent = config.limits.maxConcurrentAnalyses;
  }

  setProcessor(fn: ProcessFn): void {
    this.processFn = fn;
  }

  enqueue(item: QueueItem): void {
    // Debounce: remove any pending item for the same repo
    const existingIdx = this.queue.findIndex(
      (q) => q.repoFullName === item.repoFullName
    );
    if (existingIdx !== -1) {
      logger.info(
        { repo: item.repoFullName },
        "Debounce: replacing queued item with newer one"
      );
      this.queue.splice(existingIdx, 1);
    }

    this.queue.push(item);
    logger.info(
      { repo: item.repoFullName, queueLength: this.queue.length },
      "Item enqueued"
    );

    this.processNext();
  }

  isRepoActive(repoFullName: string): boolean {
    return this.activeJobs.has(repoFullName);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.activeJobs.size;
  }

  private async processNext(): Promise<void> {
    if (!this.processFn) return;
    if (this.activeJobs.size >= this.maxConcurrent) return;

    // Find next item that isn't already running
    const nextIdx = this.queue.findIndex(
      (q) => !this.activeJobs.has(q.repoFullName)
    );
    if (nextIdx === -1) return;

    const item = this.queue.splice(nextIdx, 1)[0];
    const childLogger = logger.child({ repo: item.repoFullName });

    childLogger.info("Starting analysis");

    const job = this.processFn(item)
      .catch((err) => {
        childLogger.error({ err }, "Analysis failed");
      })
      .finally(() => {
        this.activeJobs.delete(item.repoFullName);
        childLogger.info("Analysis slot freed");
        this.processNext();
      });

    this.activeJobs.set(item.repoFullName, job);

    // Try to fill more slots
    this.processNext();
  }
}

export const analysisQueue = new AnalysisQueue();
