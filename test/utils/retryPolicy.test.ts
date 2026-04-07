jest.mock("../../src/config", () => ({
  config: {
    limits: { rateLimitPerHour: 10 },
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

import {
  isTransientError,
  githubApiRetry,
  gitCloneRetry,
} from "../../src/utils/retryPolicy";

describe("isTransientError", () => {
  it("should detect timeout errors as transient", () => {
    expect(isTransientError(new Error("getValidToken timed out after 30000ms"))).toBe(true);
    expect(isTransientError(new Error("cloneRepo timed out after 90000ms"))).toBe(true);
  });

  it("should detect network errors as transient", () => {
    const codes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"];
    for (const code of codes) {
      const err = new Error("network error");
      (err as any).code = code;
      expect(isTransientError(err)).toBe(true);
    }
  });

  it("should detect GitHub 5xx errors as transient", () => {
    expect(isTransientError({ status: 500, message: "Internal Server Error" })).toBe(true);
    expect(isTransientError({ status: 502, message: "Bad Gateway" })).toBe(true);
    expect(isTransientError({ status: 503, message: "Service Unavailable" })).toBe(true);
  });

  it("should detect GitHub rate limit (403 + x-ratelimit-remaining: 0) as transient", () => {
    const err = {
      status: 403,
      message: "rate limit exceeded",
      response: {
        headers: { "x-ratelimit-remaining": "0" },
      },
    };
    expect(isTransientError(err)).toBe(true);
  });

  it("should detect killed process (git clone timeout) as transient", () => {
    expect(isTransientError({ killed: true, signal: "SIGTERM" })).toBe(true);
    expect(isTransientError({ killed: true })).toBe(true);
  });

  it("should NOT detect 4xx client errors as transient", () => {
    expect(isTransientError({ status: 400, message: "Bad Request" })).toBe(false);
    expect(isTransientError({ status: 404, message: "Not Found" })).toBe(false);
    expect(isTransientError({ status: 422, message: "Unprocessable" })).toBe(false);
  });

  it("should NOT detect regular 403 (permission denied) as transient", () => {
    expect(isTransientError({ status: 403, message: "Forbidden" })).toBe(false);
  });

  it("should NOT detect generic errors as transient", () => {
    expect(isTransientError(new Error("some random error"))).toBe(false);
    expect(isTransientError(new Error("Unsupported framework"))).toBe(false);
  });

  it("should handle null/undefined gracefully", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError({})).toBe(false);
  });
});

describe("githubApiRetry", () => {
  it("should succeed on first attempt without retry", async () => {
    const fn = jest.fn().mockResolvedValue("success");
    const result = await githubApiRetry(fn, "test-op");
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient error and succeed", async () => {
    const timeoutErr = new Error("timed out after 30000ms");
    const fn = jest.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue("recovered");

    const result = await githubApiRetry(fn, "test-retry");
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should abort immediately on permanent error without retry", async () => {
    const permErr = { status: 404, message: "Not Found" };
    const fn = jest.fn().mockRejectedValue(permErr);

    await expect(githubApiRetry(fn, "test-perm")).rejects.toEqual(permErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should exhaust retries on persistent transient error", async () => {
    const transientErr = new Error("timed out after 30000ms");
    const fn = jest.fn().mockRejectedValue(transientErr);

    await expect(githubApiRetry(fn, "test-exhaust")).rejects.toThrow("timed out");
    // 1 initial + 3 retries = 4 calls total
    expect(fn).toHaveBeenCalledTimes(4);
  }, 30000);
});

describe("gitCloneRetry", () => {
  it("should retry clone with fewer attempts (2 retries)", async () => {
    const transientErr = new Error("timed out after 90000ms");
    const fn = jest.fn().mockRejectedValue(transientErr);

    await expect(gitCloneRetry(fn, "clone-test")).rejects.toThrow("timed out");
    // 1 initial + 2 retries = 3 calls total
    expect(fn).toHaveBeenCalledTimes(3);
  }, 30000);

  it("should succeed after transient failure", async () => {
    const networkErr = new Error("connection reset");
    (networkErr as any).code = "ECONNRESET";
    const fn = jest.fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue("/tmp/repo");

    const result = await gitCloneRetry(fn, "clone-recover");
    expect(result).toBe("/tmp/repo");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
