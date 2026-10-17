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
  combinationSupport,
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
  const axes = [input.rows, input.columns];
  const selectedModels = [
    ...new Set(
      axes.find((axis) => axis.kind === "model")?.values ??
        [input.model].filter(Boolean),
    ),
  ].map((id) => ({ id, info: models.find((model) => model.id === id) }));
  const modelNames = selectedModels.map(({ id, info }) => info?.name ?? id);
  if (input.format !== "image") {
    const efforts = (
      axes.find((axis) => axis.kind === "effort")?.values ?? [input.effort]
    ).filter((effort) => effort !== "default");
    return {
      effort: (
        <CompatibilityGrid
          caption="Thinking effort compatibility"
          rows={modelNames}
          columns={efforts.map(effortLabel)}
          cells={selectedModels.map(({ info }) =>
            efforts.map((effort) => ({
              support: thinkingEffortSupport(info, effort),
            })),
          )}
        />
      ),
    };
  }
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
      const cells = selectedModels.map(({ id }) =>
        values.map((value) => {
          const matches = expanded
            .filter(
              (cell) =>
                cell.model === id &&
                (!side ||
                  input[side].values[
                    side === "rows" ? cell.row : cell.column
                  ] === value),
            )
            .map((cell) => cell.compatibility.parameters[kind]);
          const support = matches.length
            ? combinationSupport(matches.map((cell) => cell.support))
            : "unknown";
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
          rows={modelNames}
          columns={values.map((value) => (value === "auto" ? "Auto" : value))}
          cells={cells}
        />,
      ];
    }),
  );
}

function CompatibilityGrid({
  caption,
  rows,
  columns,
  cells,
}: {
  caption: string;
  rows: string[];
  columns: string[];
  cells: Compatibility[][];
}) {
  if (!cells.some((row) => row.some((cell) => cell.support === "unsupported")))
    return null;
  return (
    <div className="compatibility-table-scroll">
      <table className="compatibility-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
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
                    aria-label={`${label} / ${value}: ${status}`}
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
