import type { ReactNode } from "react";
import { tooltipRef } from "../components/use-tooltip";
import { Check, TriangleAlert } from "lucide-react";
import { expandGrid, type GridInput } from "../../server/domain";
import { imageKinds } from "../../server/image-settings";
import {
  effortLabel,
  thinkingEffortSupport,
  imageSettingsSupport,
  imageParameterNames,
  type Compatibility,
} from "../../server/compatibility";
import type { ModelInfo } from "../../server/model-catalog";

type Props = { input: GridInput; models: readonly ModelInfo[] };
export type CompatibilityTables = Partial<
  Record<GridInput["rows"]["kind"], ReactNode>
>;

export function compatibilityTables({
  input,
  models,
}: Props): CompatibilityTables {
  const modelAxis = [input.rows, input.columns].find(
    (axis) => axis.kind === "model",
  );
  const imageModels = [
    ...new Set(modelAxis ? modelAxis.values : [input.model].filter(Boolean)),
  ];
  if (input.format !== "image")
    return {
      effort: <ThinkingCompatibilityTable input={input} models={models} />,
    };
  // Unfilled unrelated axes do not hide compatibility for settings already chosen.
  const expanded = expandGrid({
    ...input,
    rows: {
      ...input.rows,
      values: input.rows.values.length ? input.rows.values : [""],
    },
    columns: {
      ...input.columns,
      values: input.columns.values.length ? input.columns.values : [""],
    },
  }).map((cell) => ({
    ...cell,
    compatibility: imageSettingsSupport(
      models
        .find((model) => model.id === cell.model)
        ?.imageEndpoints?.map((endpoint) => endpoint.supported_parameters),
      cell.imageSettings ?? {},
    ),
  }));
  return Object.fromEntries(
    imageKinds.map((kind) => {
      const side =
        input.rows.kind === kind
          ? "rows"
          : input.columns.kind === kind
            ? "columns"
            : undefined;
      const values = side
        ? input[side].values
        : [
            kind === "input_references"
              ? `${input.inputReferences?.length ?? 0} images`
              : input.imageSettings?.[kind] || "auto",
          ];
      const cells = imageModels.map((model) =>
        values.map((value) => {
          const matches = expanded
            .filter(
              (cell) =>
                cell.model === model &&
                (!side ||
                  input[side].values[
                    side === "rows" ? cell.row : cell.column
                  ] === value),
            )
            .map((cell) => cell.compatibility.parameters[kind]);
          const support = matches.some((cell) => cell.support === "unsupported")
            ? "unsupported"
            : !matches.length ||
                matches.some((cell) => cell.support === "unknown")
              ? "unknown"
              : "supported";
          return {
            support,
            reason:
              [
                ...new Set(
                  matches
                    .filter((cell) => cell.support === support)
                    .map((cell) => cell.reason)
                    .filter(Boolean),
                ),
              ].join("\n") || undefined,
          } as Compatibility;
        }),
      );
      return [
        kind,
        <CompatibilityGrid
          key={kind}
          caption={`${imageParameterNames[kind]} compatibility`}
          corner="Model"
          rows={imageModels.map(
            (id) => models.find((model) => model.id === id)?.name ?? id,
          )}
          columns={values.map((value) => (value === "auto" ? "Auto" : value))}
          cells={cells}
        />,
      ];
    }),
  );
}

function ThinkingCompatibilityTable({ input, models }: Props) {
  const axes = [input.rows, input.columns];
  const selectedModels =
    axes.find((axis) => axis.kind === "model")?.values ??
    [input.model].filter(Boolean);
  const selectedEfforts = (
    axes.find((axis) => axis.kind === "effort")?.values ?? [input.effort]
  ).filter((effort) => effort !== "default");
  return (
    <CompatibilityGrid
      caption="Thinking effort compatibility"
      corner="Model"
      rows={selectedModels.map(
        (id) => models.find((model) => model.id === id)?.name ?? id,
      )}
      columns={selectedEfforts.map(effortLabel)}
      cells={selectedModels.map((id) =>
        selectedEfforts.map((effort) => ({
          support: thinkingEffortSupport(
            models.find((model) => model.id === id),
            effort,
          ),
        })),
      )}
      cellLabel={(_, column) => effortLabel(selectedEfforts[column])}
    />
  );
}

function CompatibilityGrid({
  caption,
  corner,
  rows,
  columns,
  cells,
  cellLabel,
}: {
  caption: string;
  corner: string;
  rows: string[];
  columns: string[];
  cells: Compatibility[][];
  cellLabel?: (row: number, column: number) => string;
}) {
  if (!cells.some((row) => row.some((cell) => cell.support === "unsupported")))
    return null;
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{corner}</th>
            {columns.map((label, index) => (
              <th scope="col" key={index}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((label, row) => (
            <tr key={row}>
              <th scope="row">{label}</th>
              {columns.map((value, column) => {
                const { support, reason } = cells[row][column];
                const status =
                  support === "supported"
                    ? "Supported"
                    : support === "unknown"
                      ? "Support unknown"
                      : "Unsupported";
                return (
                  <td
                    key={column}
                    data-support={support}
                    aria-label={`${cellLabel ? cellLabel(row, column) : `${label} / ${value}`}: ${status}`}
                    data-tooltip={
                      support === "supported" ? undefined : (reason ?? status)
                    }
                    ref={support === "supported" ? undefined : tooltipRef}
                    tabIndex={support === "supported" ? undefined : 0}
                  >
                    {support === "supported" && <Check aria-hidden="true" />}
                    {support === "unknown" && (
                      <span aria-hidden="true">❓</span>
                    )}
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
