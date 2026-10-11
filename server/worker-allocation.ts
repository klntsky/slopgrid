// Selection is pure; active counts come from the actual running calls.
export function selectWorker(
  owners: ReadonlyMap<string, { limit: number; last: number }>,
  candidates: Iterable<string>,
  running: readonly string[],
  maximum: number,
): string | undefined {
  if (running.length >= maximum) return;
  const counts = new Map<string, number>();
  for (const owner of running) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  const eligible = new Set(candidates);
  let next: string | undefined,
    fewest = Infinity,
    oldest = Infinity;
  for (const [owner, { limit, last }] of owners) {
    const count = counts.get(owner) ?? 0;
    if (
      eligible.has(owner) &&
      count < limit &&
      (count < fewest || (count === fewest && last < oldest))
    ) {
      next = owner;
      fewest = count;
      oldest = last;
    }
  }
  return next;
}
