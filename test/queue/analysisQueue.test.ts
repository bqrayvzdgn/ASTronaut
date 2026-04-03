jest.mock("../../src/config", () => ({
  config: {
    limits: { maxConcurrentAnalyses: 2 },
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

import { analysisQueue } from "../../src/queue/analysisQueue";

describe("analysisQueue", () => {
  it("should report queue length", () => {
    expect(typeof analysisQueue.getQueueLength()).toBe("number");
  });

  it("should report active count", () => {
    expect(typeof analysisQueue.getActiveCount()).toBe("number");
  });

  it("should report repo active status", () => {
    expect(analysisQueue.isRepoActive("nonexistent/repo")).toBe(false);
  });

  it("should accept a processor function", () => {
    expect(() => {
      analysisQueue.setProcessor(async () => {});
    }).not.toThrow();
  });

  it("should enqueue items and process them", (done) => {
    const processed: string[] = [];

    analysisQueue.setProcessor(async (item) => {
      processed.push(item.repoFullName);
      if (processed.length === 1) {
        expect(processed).toContain("test/enqueue-repo");
        done();
      }
    });

    analysisQueue.enqueue({
      id: `test-enqueue-${Date.now()}`,
      repoFullName: "test/enqueue-repo",
      payload: {},
      addedAt: Date.now(),
    });
  });
});
