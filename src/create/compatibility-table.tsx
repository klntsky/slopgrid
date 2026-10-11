import { tooltipRef } from "../components/use-tooltip";
import { Check, TriangleAlert } from "lucide-react";
import { efforts, type GridInput } from "../../server/domain";
import { effortLabel, thinkingEffortSupport } from "../../server/compatibility";
import type { Model } from "../../server/provider";

export function CompatibilityTable({
  input,
  models,
}: {
  input: GridInput;
  models: readonly Model[];
}) {
  const modelIds = [
    ...new Set(
      input.rows.kind === "model"
        ? input.rows.values
        : input.columns.kind === "model"
          ? input.columns.values
          : [input.model],
    ),
  ].filter(Boolean);
  const selectedEfforts =
    input.rows.kind === "effort"
      ? input.rows.values
      : input.columns.kind === "effort"
        ? input.columns.values
        : [input.effort];
  const pickedEfforts = efforts.filter((effort) =>
    selectedEfforts.includes(effort),
  );
  if (input.format === "image" || !modelIds.length || !pickedEfforts.length)
    return null;
  const rows = modelIds.map((id) => {
    const model = models.find((candidate) => candidate.id === id);
    return {
      id,
      name: model?.name ?? id,
      support: pickedEfforts.map((effort) =>
        thinkingEffortSupport(model, effort),
      ),
    };
  });
  if (!rows.some((row) => row.support.includes("unsupported"))) return null;
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>Thinking effort compatibility</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            {pickedEfforts.map((effort) => (
              <th scope="col" key={effort}>
                {effortLabel(effort)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th
                scope="row"
                data-tooltip={row.id}
                ref={tooltipRef}
                tabIndex={0}
              >
                {row.name}
              </th>
              {pickedEfforts.map((effort, index) => {
                const support = row.support[index];
                const status =
                  support === "supported"
                    ? "Supported"
                    : support === "unknown"
                      ? "Support unknown"
                      : "Unsupported";
                return (
                  <td
                    key={effort}
                    aria-label={`${effortLabel(effort)}: ${status}`}
                    data-tooltip={support === "supported" ? undefined : status}
                    ref={support === "supported" ? undefined : tooltipRef}
                    tabIndex={support === "supported" ? undefined : 0}
                  >
                    {support === "supported" && <Check aria-hidden="true" />}
                    {support === "unsupported" && (
                      <TriangleAlert
                        className="compatibility-warning"
                        aria-hidden="true"
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
