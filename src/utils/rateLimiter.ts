import { config } from "../config";

const windowMs = 60 * 60 * 1000; // 1 hour

interface RequestRecord {
  timestamps: number[];
}

const store = new Map<string, RequestRecord>();

export function checkRateLimit(repoFullName: string): boolean {
  const now = Date.now();
  const maxRequests = config.limits.rateLimitPerHour;

  let record = store.get(repoFullName);
  if (!record) {
    record = { timestamps: [] };
    store.set(repoFullName, record);
  }

  // Sliding window: remove timestamps older than 1 hour
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  // Evict empty entries to prevent memory leak over time
  if (record.timestamps.length === 0) {
    store.delete(repoFullName);
    return true;
  }

  if (record.timestamps.length >= maxRequests) {
    return false;
  }

  record.timestamps.push(now);
  return true;
}

/** Visible for testing */
export function resetRateLimiter(): void {
  store.clear();
}
