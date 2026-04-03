jest.mock("../../src/config", () => ({
  config: {
    limits: { rateLimitPerHour: 3 },
  },
}));

import { checkRateLimit, resetRateLimiter } from "../../src/utils/rateLimiter";

describe("rateLimiter", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it("should allow requests under the limit", () => {
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
  });

  it("should reject requests over the limit", () => {
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(false);
  });

  it("should track repos independently", () => {
    expect(checkRateLimit("owner/repo-a")).toBe(true);
    expect(checkRateLimit("owner/repo-a")).toBe(true);
    expect(checkRateLimit("owner/repo-a")).toBe(true);
    expect(checkRateLimit("owner/repo-a")).toBe(false);

    // Different repo should still be allowed
    expect(checkRateLimit("owner/repo-b")).toBe(true);
  });

  it("should allow requests after window expires", () => {
    const realDateNow = Date.now;

    let now = 1000000;
    Date.now = jest.fn(() => now);

    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(true);
    expect(checkRateLimit("owner/repo")).toBe(false);

    // Advance past 1 hour window
    now += 60 * 60 * 1000 + 1;
    expect(checkRateLimit("owner/repo")).toBe(true);

    Date.now = realDateNow;
  });

  it("should evict empty entries after window expires", () => {
    const realDateNow = Date.now;

    let now = 1000000;
    Date.now = jest.fn(() => now);

    checkRateLimit("owner/repo");

    // Advance past window
    now += 60 * 60 * 1000 + 1;

    // Next call should evict and return true
    expect(checkRateLimit("owner/repo")).toBe(true);

    Date.now = realDateNow;
  });

  it("should reset all state", () => {
    checkRateLimit("owner/repo");
    checkRateLimit("owner/repo");
    checkRateLimit("owner/repo");
    expect(checkRateLimit("owner/repo")).toBe(false);

    resetRateLimiter();
    expect(checkRateLimit("owner/repo")).toBe(true);
  });
});
