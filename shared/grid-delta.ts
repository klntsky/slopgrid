// Wire values have already passed through JSON serialization, so absent fields
// are represented by removals rather than undefined values.
export type Delta =
  | { set: unknown }
  | { append: string }
  | { fields: Record<string, Delta>; remove: string[] };

export function gridDelta(before: unknown, after: unknown): Delta | undefined {
  if (before === after) return;
  if (
    typeof before === "string" &&
    typeof after === "string" &&
    after.startsWith(before)
  )
    return { append: after.slice(before.length) };
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after) &&
    (!Array.isArray(before) || before.length === (after as unknown[]).length)
  ) {
    const previous = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    const fields: Record<string, Delta> = Object.create(null);
    const remove = Object.keys(previous).filter(
      (key) => !Object.hasOwn(next, key),
    );
    for (const key of Object.keys(next)) {
      const change = Object.hasOwn(previous, key)
        ? gridDelta(previous[key], next[key])
        : { set: next[key] };
      if (change) fields[key] = change;
    }
    if (remove.length || Object.keys(fields).length) return { fields, remove };
    return;
  }
  return { set: after };
}

export function applyDelta(before: unknown, delta: Delta): unknown {
  if ("set" in delta) return delta.set;
  if ("append" in delta) {
    if (typeof before !== "string") throw new Error("Invalid stream append");
    return before + delta.append;
  }
  if (before === null || typeof before !== "object")
    throw new Error("Invalid stream fields");
  const result = (
    Array.isArray(before) ? [...before] : { ...before }
  ) as Record<string, unknown>;
  for (const key of delta.remove) delete result[key];
  for (const [key, change] of Object.entries(delta.fields)) {
    Object.defineProperty(result, key, {
      value: applyDelta(
        Object.hasOwn(result, key) ? result[key] : undefined,
        change,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export type GridStreamMessage<T> =
  { snapshot: T } | { base: string; delta: Delta };
