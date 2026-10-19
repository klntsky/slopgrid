import { token } from "./ids.js";

// Recovery data is private to a viewer and bounded across all subscriptions.
export function createStreamHistory<T>(
  maxBytes = 32 * 1024 * 1024,
  ttl = 60000,
  now = Date.now,
) {
  const entries = new Map<
    string,
    { scope: string; value: T; bytes: number; expires: number }
  >();
  let bytes = 0;
  function prune() {
    for (const [id, entry] of entries) {
      if (entry.expires > now() && bytes <= maxBytes && entries.size <= 128)
        break;
      entries.delete(id);
      bytes -= entry.bytes;
    }
  }
  return {
    get(id: string, scope: string) {
      prune();
      const entry = entries.get(id);
      return entry?.scope === scope ? entry.value : undefined;
    },
    put(scope: string, value: T, size: number) {
      const id = token();
      entries.set(id, { scope, value, bytes: size, expires: now() + ttl });
      bytes += size;
      prune();
      return id;
    },
  };
}
