export type ScrollLayout = {
  limit: number;
  // Matched item starts/ends in content coordinates, including intervening gaps.
  anchors: readonly number[];
};

export function buildScrollMap(source: ScrollLayout, target: ScrollLayout) {
  if (source.limit <= 0 || target.limit <= 0) return () => 0;
  const knots = [0, 0];
  const count = Math.min(source.anchors.length, target.anchors.length);
  for (let i = 0; i < count; i++) {
    const x = source.anchors[i];
    // Endpoint anchors own collapsed ranges. Keep one value at shared edges.
    if (x <= knots[knots.length - 2] || x >= source.limit) continue;
    knots.push(x, Math.max(0, Math.min(target.limit, target.anchors[i])));
  }
  knots.push(source.limit, target.limit);
  return (position: number) => {
    const x = Math.max(0, Math.min(source.limit, position));
    let low = 0;
    let high = knots.length / 2 - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (knots[middle * 2] <= x) low = middle;
      else high = middle;
    }
    const start = low * 2;
    const end = high * 2;
    return (
      knots[start + 1] +
      ((x - knots[start]) / (knots[end] - knots[start])) *
        (knots[end + 1] - knots[start + 1])
    );
  };
}
