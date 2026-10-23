import { WarningMessage } from "../components/feedback-message";
import { expandGrid, type GridInput } from "../../server/domain";
import { templateSequence } from "../../server/chat-template";
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
  const cells = expandGrid(input);
  const pipelineCalls =
    input.format === "chat-template"
      ? cells.reduce(
          (highest, cell) =>
            Math.max(
              highest,
              templateSequence(cell.messages ?? []).filter(
                (message) => message.role === "unfilled",
              ).length,
            ),
          0,
        )
      : 0;
  cells.forEach((cell, index) => {
    if (!cell.model) return;
    const group = grouped.get(cell.model) ?? [];
    group.push(estimates[index]);
    grouped.set(cell.model, group);
  });
  const warnings = [...grouped].filter(([, group]) =>
    group.some(
      (estimate) =>
        estimate.support === "unsupported" ||
        (estimate.support === "unknown" && estimate.reason),
    ),
  );
  if (!warnings.length && pipelineCalls < 2) return null;
  return (
    <div className="budget-warnings">
      {pipelineCalls > 1 && (
        <WarningMessage>
          This setup uses {pipelineCalls} "unfilled" chat history entries.
          Inference will run {pipelineCalls} times. We can't pre-compute a hard
          max_output_tokens limit in advance based on the budget, because we
          don't know how many tokens will be produced by the first run (next
          run's inputs are previous run's outputs + new messages). For this
          reason, we can't guarantee that the budget limit per cell will be
          enough to cover the whole pipeline. However, we do guarantee that the
          total budget limit will not be exceeded: for subsequent calls,
          max_output_tokens is computed based on the remaining cell budget
        </WarningMessage>
      )}
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
            group.flatMap((estimate) =>
              estimate.support === "unknown" && estimate.reason
                ? [estimate.reason]
                : [],
            ),
          ),
        ];
        return (
          <WarningMessage key={id}>
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
          </WarningMessage>
        );
      })}
    </div>
  );
}
