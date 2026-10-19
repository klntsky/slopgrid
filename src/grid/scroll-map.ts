export type ScrollMap = {
  project(point: number): number;
  follow(from: number, to: number, focusDelta: number): number;
};

export function buildScrollMap(
  source: readonly number[],
  target: readonly number[],
): ScrollMap {
  const points: number[] = [];
  const values: number[] = [];
  const count = Math.min(source.length, target.length);
  for (let i = 0; i < count; i++) {
    const point = source[i];
    const value = target[i];
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

  function follow(from: number, to: number, focusDelta: number): number {
    if (last < 1 || from === to) return 0;
    if (focusDelta === 0) return project(to) - project(from);

    const direction = to > from ? 1 : -1;
    const distance = Math.abs(to - from);
    const end = Math.max(from, to);
    let point = Math.min(from, to);
    let segment = segmentAt(point);
    let movement = 0;
    while (point < end) {
      const next = segment < last ? Math.min(end, points[segment + 1]) : end;
      const length = next - point;
      const slope = segment < 0 || segment >= last ? 0 : slopes[segment];
      const delta =
        direction * slope * length - focusDelta * (length / distance);
      // Filter each actual linear segment, not the whole event: a short
      // area can pause without cancelling movement in the next area.
      if (delta * direction > 0) movement += delta;
      point = next;
      segment++;
    }
    return movement;
  }

  return { project, follow };
}
