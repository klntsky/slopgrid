import { useQueries } from "@tanstack/react-query";
import { api } from "../api";
import type { ImageCapabilities } from "../../server/image-settings";
import { tooltipRef } from "../components/use-tooltip";
import { Check, TriangleAlert } from "lucide-react";
import { expandGrid, type GridInput } from "../../server/domain";
import {
  effortLabel,
  thinkingEffortSupport,
  imageSettingsSupport,
} from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { dimensionNames, displayValue } from "../format";

export function CompatibilityTable({
  input,
  models,
}: {
  input: GridInput;
  models: readonly Model[];
}) {
  const expanded = expandGrid(input);
  const imageModels =
    input.format === "image"
      ? [...new Set(expanded.map((cell) => cell.model).filter(Boolean))]
      : [];
  const capabilities = useQueries({
    queries: imageModels.map((model) => ({
      queryKey: ["image-capabilities", model],
      queryFn: () =>
        api<ImageCapabilities[]>(
          `/models/image-capabilities?model=${encodeURIComponent(model)}`,
        ),
      staleTime: 300000,
      retry: 1,
    })),
  });
  if (![input.rows.kind, input.columns.kind].includes("model") && !input.model)
    return null;
  const cells = expanded.map(({ model, effort, imageSettings }) => ({
    effort,
    ...(input.format === "image"
      ? imageSettingsSupport(
          capabilities[imageModels.indexOf(model)]?.data,
          imageSettings ?? {},
        )
      : {
          support: thinkingEffortSupport(
            models.find((candidate) => candidate.id === model),
            effort,
          ),
          reason: undefined,
        }),
  }));
  if (!cells.some((cell) => cell.support === "unsupported")) return null;
  const label = (value: string, kind: GridInput["rows"]["kind"]) =>
    kind === "model"
      ? (models.find((model) => model.id === value)?.name ?? value)
      : displayValue(value, kind);
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>
          {input.format === "image"
            ? "Image settings compatibility"
            : "Thinking effort compatibility"}
        </caption>
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
                const { effort, support, reason } =
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
                    aria-label={`${input.format === "image" ? `${label(value, input.rows.kind)} / ${label(input.columns.values[column], input.columns.kind)}` : effortLabel(effort)}: ${status}`}
                    data-tooltip={
                      support === "supported" ? undefined : (reason ?? status)
                    }
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
