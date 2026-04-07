jest.mock("../../src/config", () => ({
  config: {
    limits: { maxConcurrentAnalyses: 2, maxQueueSize: 3 },
    timeouts: { jobMs: 5000 },
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

import { AnalysisQueue, QueueItem } from "../../src/queue/analysisQueue";

function makeItem(repo: string): QueueItem {
  return {
    id: `${repo}-${Date.now()}-${Math.random()}`,
    repoFullName: repo,
    payload: {},
    addedAt: Date.now(),
  };
}

describe("analysisQueue", () => {
  let queue: AnalysisQueue;

  beforeEach(() => {
    queue = new AnalysisQueue();
  });

  it("should report queue length", () => {
    expect(queue.getQueueLength()).toBe(0);
  });

  it("should report active count", () => {
    expect(queue.getActiveCount()).toBe(0);
  });

  it("should report repo active status", () => {
    expect(queue.isRepoActive("nonexistent/repo")).toBe(false);
  });

  it("should accept a processor function", () => {
    expect(() => {
      queue.setProcessor(async () => {});
    }).not.toThrow();
  });

  it("should enqueue items and process them", (done) => {
    queue.setProcessor(async (item) => {
      expect(item.repoFullName).toBe("test/enqueue-repo");
      done();
    });

    queue.enqueue(makeItem("test/enqueue-repo"));
  });

  it("should debounce — replace pending item for same repo", (done) => {
    const processed: string[] = [];

    queue.setProcessor(async (item) => {
      processed.push(item.id);
      // Only the second item's ID should be processed
      expect(item.id).toContain("second");
      done();
    });

    const first = makeItem("test/debounce");
    first.id = "first";
    const second = makeItem("test/debounce");
    second.id = "second";

    // Enqueue without processor to accumulate
    queue.enqueue(first);
    // Second enqueue should replace first
    queue.enqueue(second);
  });

  it("should respect concurrency limit", (done) => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    let completed = 0;

    queue.setProcessor(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 50));
      concurrentCount--;
      completed++;
      if (completed === 3) {
        expect(maxConcurrent).toBeLessThanOrEqual(2);
        done();
      }
    });

    queue.enqueue(makeItem("repo/a"));
    queue.enqueue(makeItem("repo/b"));
    queue.enqueue(makeItem("repo/c"));
  });

  it("should recover from processor errors and continue", (done) => {
    let callCount = 0;

    queue.setProcessor(async (item) => {
      callCount++;
      if (item.repoFullName === "repo/fail") {
        throw new Error("deliberate failure");
      }
      // Second item should still process after first fails
      expect(item.repoFullName).toBe("repo/ok");
      expect(callCount).toBe(2);
      done();
    });

    queue.enqueue(makeItem("repo/fail"));
    queue.enqueue(makeItem("repo/ok"));
  });

  it("should reject items when queue is at capacity", () => {
    // maxQueueSize is 3 in mock config
    queue.setProcessor(async () => {
      await new Promise((r) => setTimeout(r, 1000));
    });

    // Fill up: 2 will start processing (maxConcurrent=2), 1 stays in queue
    expect(queue.enqueue(makeItem("repo/1"))).toBe(true);
    expect(queue.enqueue(makeItem("repo/2"))).toBe(true);
    expect(queue.enqueue(makeItem("repo/3"))).toBe(true);
    expect(queue.enqueue(makeItem("repo/4"))).toBe(true);
    expect(queue.enqueue(makeItem("repo/5"))).toBe(true);

    // Queue should eventually reject when at capacity
    // The exact threshold depends on how many moved to active vs stayed in queue
    // But with 5 unique repos and maxConcurrent=2, 3 remain in queue = maxQueueSize
    expect(queue.enqueue(makeItem("repo/6"))).toBe(false);
  });

  it("should drain when all jobs complete", async () => {
    queue.setProcessor(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    queue.enqueue(makeItem("repo/drain-a"));
    queue.enqueue(makeItem("repo/drain-b"));

    await queue.drain();
    expect(queue.getActiveCount()).toBe(0);
  });

  it("should return enqueue result as boolean", () => {
    queue.setProcessor(async () => {});
    const result = queue.enqueue(makeItem("repo/bool-test"));
    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
  });
});
