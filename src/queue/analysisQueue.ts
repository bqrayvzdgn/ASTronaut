import { config } from "../config";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/withTimeout";

export interface QueueItem {
  id: string;
  repoFullName: string;
  payload: unknown;
  addedAt: number;
  webhookEventId?: number;
}

type ProcessFn = (item: QueueItem) => Promise<void>;

export class AnalysisQueue {
  private queue: QueueItem[] = [];
  private activeJobs = new Map<string, Promise<void>>();
  private processFn: ProcessFn | null = null;
  private maxConcurrent: number;
  private maxQueueSize: number;
  private jobTimeoutMs: number;
  private drainResolvers: Array<() => void> = [];

  constructor() {
    this.maxConcurrent = config.limits.maxConcurrentAnalyses;
    this.maxQueueSize = config.limits.maxQueueSize;
    this.jobTimeoutMs = config.timeouts.jobMs;
  }

  setProcessor(fn: ProcessFn): void {
    this.processFn = fn;
  }

  enqueue(item: QueueItem): boolean {
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

    // Reject if queue is at capacity
    if (this.queue.length >= this.maxQueueSize) {
      logger.warn(
        { repo: item.repoFullName, queueLength: this.queue.length },
        "Queue at capacity — rejecting item"
      );
      return false;
    }

    this.queue.push(item);
    logger.info(
      { repo: item.repoFullName, queueLength: this.queue.length },
      "Item enqueued"
    );

    this.processNext();
    return true;
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

  /**
   * Returns a promise that resolves when all active jobs have completed.
   * Used for graceful shutdown.
   */
  drain(): Promise<void> {
    if (this.activeJobs.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
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

    const job = withTimeout(
      this.processFn(item),
      this.jobTimeoutMs,
      `job:${item.repoFullName}`
    )
      .catch((err) => {
        childLogger.error({ err }, "Analysis failed");
      })
      .finally(() => {
        this.activeJobs.delete(item.repoFullName);
        childLogger.info("Analysis slot freed");

        // Notify drain waiters if queue and active jobs are both empty
        if (this.activeJobs.size === 0 && this.queue.length === 0) {
          for (const resolve of this.drainResolvers) resolve();
          this.drainResolvers = [];
        }

        this.processNext();
      });

    this.activeJobs.set(item.repoFullName, job);

    // Try to fill more slots
    this.processNext();
  }
}

export const analysisQueue = new AnalysisQueue();
