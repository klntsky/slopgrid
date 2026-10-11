import { Check } from "lucide-react";
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
          {modelIds.map((id) => {
            const model = models.find((candidate) => candidate.id === id);
            return (
              <tr key={id}>
                <th scope="row" title={id}>
                  {model?.name ?? id}
                </th>
                {pickedEfforts.map((effort) => {
                  const support = thinkingEffortSupport(model, effort);
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
                      title={status}
                    >
                      {support === "supported" && <Check aria-hidden="true" />}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
