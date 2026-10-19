export type ScrollLayout = {
  limit: number;
  // Matched item starts/ends in content coordinates, including intervening gaps.
  anchors: readonly number[];
};

export type ScrollMap = {
  project(point: number): number;
};

export function buildScrollMap(
  source: ScrollLayout,
  target: ScrollLayout,
): ScrollMap {
  const points: number[] = [];
  const values: number[] = [];
  const count = Math.min(source.anchors.length, target.anchors.length);
  for (let i = 0; i < count; i++) {
    const point = source.anchors[i];
    const value = target.anchors[i];
    const last = points.length - 1;
    if (last >= 0) {
      // A collapsed source area has no interpolation span. Its end owns
      // the shared coordinate so the following area still starts there.
      if (point === points[last]) {
        values[last] = value;
        continue;
      }
    }
    points.push(point);
    values.push(value);
  }

  const last = points.length - 1;
  const slopes: number[] = [];
  for (let i = 0; i < last; i++) {
    slopes.push((values[i + 1] - values[i]) / (points[i + 1] - points[i]));
  }

  // Find the segment to the right of a boundary; -1 and last are the
  // constant portions outside the common matched span.
  function segmentAt(point: number): number {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (points[middle] <= point) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  function project(point: number): number {
    if (last < 0) return 0;
    if (point <= points[0]) return values[0];
    if (point >= points[last]) return values[last];
    const segment = segmentAt(point);
    return values[segment] + (point - points[segment]) * slopes[segment];
  }

  return { project };
}
