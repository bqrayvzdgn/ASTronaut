import { logger } from "./logger";

export interface RetryOptions {
  retries: number;
  minTimeout: number;
  factor: number;
  randomize: boolean;
}

/**
 * Determine whether an error is transient (worth retrying) or permanent.
 * Transient: network issues, GitHub 5xx, timeouts, rate limits.
 * Permanent: 4xx client errors, validation failures, permission denied.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  // Timeout errors (from withTimeout utility)
  if (typeof e.message === "string" && e.message.includes("timed out")) return true;

  // Node.js network errors
  const networkCodes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"];
  if (typeof e.code === "string" && networkCodes.includes(e.code)) return true;

  // GitHub API 5xx server errors
  if (typeof e.status === "number" && e.status >= 500) return true;

  // GitHub rate limit (403 with x-ratelimit-remaining: 0)
  if (
    e.status === 403 &&
    (e.response as Record<string, unknown> | undefined)?.headers &&
    ((e.response as Record<string, Record<string, string>>).headers?.["x-ratelimit-remaining"] === "0")
  ) {
    return true;
  }

  // Git clone / child process killed by timeout
  if (e.killed === true || e.signal === "SIGTERM") return true;

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, opts: RetryOptions): number {
  const base = opts.minTimeout * Math.pow(opts.factor, attempt - 1);
  if (!opts.randomize) return base;
  // Add jitter: random value between 0 and base
  return base + Math.random() * base;
}

/**
 * Retry a function with exponential backoff and jitter.
 * Aborts immediately on permanent errors (non-transient).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  label: string
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      // Permanent error — do not retry
      if (!isTransientError(err)) throw err;

      // Exhausted retries
      if (attempt > opts.retries) throw err;

      const delay = computeDelay(attempt, opts);
      logger.warn(
        {
          label,
          attempt,
          retriesLeft: opts.retries - attempt,
          delayMs: Math.round(delay),
          error: err instanceof Error ? err.message : String(err),
        },
        `Retrying ${label} after transient error`
      );

      await sleep(delay);
    }
  }
}

/** Retry profile for GitHub API calls (token, permissions, PR creation) */
export function githubApiRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return withRetry(fn, {
    retries: 3,
    minTimeout: 1000,
    factor: 2,
    randomize: true,
  }, label);
}

/** Retry profile for git clone (heavier operation, fewer retries) */
export function gitCloneRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return withRetry(fn, {
    retries: 2,
    minTimeout: 2000,
    factor: 2,
    randomize: true,
  }, label);
}
