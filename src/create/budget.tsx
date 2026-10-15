import { expandGrid, type GridInput } from "../../server/domain";
import { estimateGrid, type CostEstimate } from "../../server/cost-estimates";
import { TriangleAlert } from "lucide-react";
import { catalog, modelName } from "./models";
import { Hint } from "../components/ui";

export function BudgetWarnings({ input }: { input: GridInput }) {
  const { input: resolved, estimates } = estimateGrid(input, catalog);
  const cells = expandGrid(resolved),
    grouped = new Map<string, CostEstimate[]>();
  estimates.forEach((estimate, i) => {
    if (estimate.support === "supported") return;
    const id = cells[i].model;
    grouped.set(id, [...(grouped.get(id) ?? []), estimate]);
  });
  if (!grouped.size) return null;
  return (
    <div className="budget-warnings">
      {[...grouped].map(([id, values]) => {
        const calculated = values
          .filter((e) => e.maximumCostUsd !== undefined)
          .sort((a, b) => b.maximumCostUsd! - a.maximumCostUsd!)[0];
        const unknown = values.some((e) => e.support === "unknown");
        return (
          <p key={id}>
            <TriangleAlert className="warning" /> {modelName(id)}:{" "}
            {calculated && (
              <Hint text={calculated.reason}>
                <span tabIndex={0} data-tooltip={calculated.reason}>
                  $
                  {calculated.maximumCostUsd!.toLocaleString("en-US", {
                    maximumFractionDigits: 6,
                  })}
                </span>
              </Hint>
            )}
            {unknown && (
              <span data-estimate="unknown">
                {calculated ? "; " : ""}Unknown estimate
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}
