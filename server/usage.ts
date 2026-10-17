import type { Cell } from "./domain.js";

// Unknown totals remain unknown instead of displaying a partial sum as a total.
export function sumUsage(usages: Cell["usage"][]): Cell["usage"] {
  const total: NonNullable<Cell["usage"]> = {};
  for (const key of ["inputTokens", "outputTokens", "costUsd"] as const)
    if (usages.every((usage) => usage?.[key] !== undefined))
      total[key] = usages.reduce((sum, usage) => sum + usage![key]!, 0);
  return total;
}
