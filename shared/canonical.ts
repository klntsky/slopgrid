/**
 * Normalize configuration for deterministic JSON signatures: sort object keys
 * recursively and omit undefined object properties, while preserving array order.
 *
 * @example
 * canonical({ b: [{ z: 2, a: 1 }], a: undefined });
 * // { b: [{ a: 1, z: 2 }] }
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
