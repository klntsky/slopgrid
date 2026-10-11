import { tooltipRef } from "../components/use-tooltip";
import { Check, TriangleAlert } from "lucide-react";
import { expandGrid, type GridInput } from "../../server/domain";
import { effortLabel, thinkingEffortSupport } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { dimensionNames, displayValue } from "../format";

export function CompatibilityTable({
  input,
  models,
}: {
  input: GridInput;
  models: readonly Model[];
}) {
  if (
    input.format === "image" ||
    (![input.rows.kind, input.columns.kind].includes("model") && !input.model)
  )
    return null;
  const cells = expandGrid(input).map(({ model, effort }) => ({
    effort,
    support: thinkingEffortSupport(
      models.find((candidate) => candidate.id === model),
      effort,
    ),
  }));
  if (!cells.some((cell) => cell.support === "unsupported")) return null;
  const label = (value: string, kind: GridInput["rows"]["kind"]) =>
    kind === "model"
      ? (models.find((model) => model.id === value)?.name ?? value)
      : displayValue(value, kind);
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>Thinking effort compatibility</caption>
        <thead>
          <tr>
            <th scope="col">{dimensionNames[input.rows.kind]}</th>
            {input.columns.values.map((value, column) => (
              <th scope="col" key={column}>
                {label(value, input.columns.kind)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {input.rows.values.map((value, row) => (
            <tr key={row}>
              <th scope="row">{label(value, input.rows.kind)}</th>
              {input.columns.values.map((_, column) => {
                const { effort, support } =
                  cells[row * input.columns.values.length + column];
                const status =
                  support === "supported"
                    ? "Supported"
                    : support === "unknown"
                      ? "Support unknown"
                      : "Unsupported";
                return (
                  <td
                    key={column}
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
