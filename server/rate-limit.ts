export function createRateLimiter() {
  const buckets = new Map<string, { count: number; expires: number }>();
  function rate(key: string, limit: number, period = 3600000) {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.expires < now) buckets.delete(k);
    const b = buckets.get(key) ?? { count: 0, expires: now + period };
    b.count++;
    buckets.set(key, b);
    return b.count <= limit;
  }
  return rate;
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
