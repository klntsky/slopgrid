import { TriangleAlert } from "lucide-react";
import { expandGrid, type GridInput } from "../../server/domain";
import type { CostEstimate } from "../../server/cost-estimates";
import type { ModelInfo } from "../../server/model-catalog";
import { tooltipRef } from "../components/use-tooltip";

export function BudgetWarnings({
  input,
  models,
  estimates,
}: {
  input: GridInput;
  models: readonly ModelInfo[];
  estimates: readonly CostEstimate[];
}) {
  const grouped = new Map<string, CostEstimate[]>();
  expandGrid(input).forEach((cell, index) => {
    if (!cell.model) return;
    const group = grouped.get(cell.model) ?? [];
    group.push(estimates[index]);
    grouped.set(cell.model, group);
  });
  const warnings = [...grouped].filter(([, group]) =>
    group.some((estimate) => estimate.support !== "supported"),
  );
  if (!warnings.length) return null;
  return (
    <div className="budget-warnings">
      {warnings.map(([id, group]) => {
        const reduced = group
          .filter((estimate) => estimate.support === "unsupported")
          .reduce<CostEstimate | undefined>(
            (highest, estimate) =>
              !highest || estimate.maximumCostUsd! > highest.maximumCostUsd!
                ? estimate
                : highest,
            undefined,
          );
        const unknown = [
          ...new Set(
            group
              .filter((estimate) => estimate.support === "unknown")
              .map((estimate) => estimate.reason),
          ),
        ];
        return (
          <p key={id}>
            <TriangleAlert className="compatibility-warning" aria-hidden="true" />{" "}
            <strong>
              {models.find((model) => model.id === id)?.name ?? id}
            </strong>
            :{" "}
            {reduced && (
              <span ref={tooltipRef} data-tooltip={reduced.reason} tabIndex={0}>
                Estimated max call cost $
                {reduced.maximumCostUsd!.toLocaleString("en-US", {
                  maximumFractionDigits: 6,
                  useGrouping: false,
                })}{" "}
                exceeds the ${input.budgetUsd} limit.
              </span>
            )}
            {unknown.length > 0 && (
              <span data-estimate="unknown"> {unknown.join(" ")}</span>
            )}
          </p>
        );
      })}
    </div>
  );
}
