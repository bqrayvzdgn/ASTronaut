import { config } from "../config";

const windowMs = 60 * 60 * 1000; // 1 hour
const EVICTION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface RequestRecord {
  timestamps: number[];
}

const store = new Map<string, RequestRecord>();

export function checkRateLimit(repoFullName: string): boolean {
  const key = `analysis:${repoFullName}`;
  const now = Date.now();
  const maxRequests = config.limits.rateLimitPerHour;

  let record = store.get(key);
  if (!record) {
    record = { timestamps: [now] };
    store.set(key, record);
    return true;
  }

  // Sliding window: remove timestamps older than 1 hour
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  // Evict empty entries to prevent memory leak over time
  if (record.timestamps.length === 0) {
    store.delete(key);
    record = { timestamps: [now] };
    store.set(key, record);
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

/** Periodic eviction of stale entries */
const evictionInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of store) {
    record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);
    if (record.timestamps.length === 0) {
      store.delete(key);
    }
  }
}, EVICTION_INTERVAL_MS);
evictionInterval.unref();

/** Clear the eviction interval — used for graceful shutdown */
export function clearEvictionInterval(): void {
  clearInterval(evictionInterval);
}
