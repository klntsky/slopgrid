import type { ViewGrid } from "../api.js";

type CostCell = {
  outputReady?: boolean;
  status: ViewGrid["cells"][number]["status"];
  usage?: { costUsd?: number };
  estimatedUsage?: { costUsd?: number };
};

export type GridCost = {
  total?: number;
  text: string;
  approximate: boolean;
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  roundingMode: "trunc",
});

/**
 * Totals the generation costs displayed for a grid. A total that leaves out
 * unreported charges ends with "+" so it never passes for a complete total.
 */
export function gridCost(cells: readonly CostCell[]): GridCost {
  let total = 0,
    known = 0,
    approximate = false,
    unknown = false;
  for (const cell of cells) {
    if (!cell.outputReady && cell.status !== "running") continue;
    const cost = cell.outputReady
      ? cell.usage?.costUsd
      : cell.estimatedUsage?.costUsd;
    if (cost === undefined) {
      unknown = true;
      continue;
    }
    total += cost;
    known++;
    if (!cell.outputReady) approximate = true;
  }
  if (!known)
    return unknown
      ? { text: "Cost unavailable", approximate }
      : { total: 0, text: usd.format(0), approximate };
  return {
    total,
    text: `${approximate ? "≈" : ""}${usd.format(total)}${unknown ? "+" : ""}`,
    approximate,
  };
}
