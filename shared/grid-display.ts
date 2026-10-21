import type { ParameterValues, StoredGridInput } from "../server/domain.js";
import type { ReferenceImage } from "../server/image-settings.js";
import { selectedReferences } from "../server/image-settings.js";
import type { Criterion } from "../server/judge-criteria.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import {
  axisParameters,
  isCurrentGridInput,
  parameterValue,
  type AxisSide,
  type ParameterId,
} from "../server/parameters.js";
import {
  resolveLegacyCriteriaForCell,
  type LegacyGridInput,
} from "../server/legacy-grid-input.js";
import { migrateVariableInput } from "./variable-migration.js";

export type ParameterDisplayPart =
  | {
      [K in ParameterId]: { kind: K; value: ParameterValues[K] };
    }[ParameterId]
  | {
      kind: "images";
      value: { name: string; images: ReferenceImage[] };
    };
export type CaseDisplay = {
  parts: ParameterDisplayPart[];
  downloadLabel: string;
};
export type GridDisplay = {
  rows: CaseDisplay[];
  columns: CaseDisplay[];
  common: ParameterDisplayPart[];
  promptImages: ReferenceImage[];
  references: ReferenceImage[];
};

function part<K extends ParameterId>(
  kind: K,
  value: ParameterValues[K],
): ParameterDisplayPart {
  return { kind, value } as ParameterDisplayPart;
}

function downloadPart(part: ParameterDisplayPart): string {
  switch (part.kind) {
    case "variable":
      return part.value
        .map(
          (field) =>
            field.text ||
            field.images?.map((image) => image.name).join(" ") ||
            "",
        )
        .join(" ");
    case "images":
      return (
        part.value.name ||
        part.value.images.map((image) => image.name).join(" ")
      );
    case "judge_criteria":
      return part.value.map((criterion) => criterion.text).join(" ");
    default:
      return part.value;
  }
}

export function gridDimensions(input: StoredGridInput): {
  rows: number;
  columns: number;
} {
  return isCurrentGridInput(input)
    ? { rows: input.rows.length, columns: input.columns.length }
    : { rows: input.rows.values.length, columns: input.columns.values.length };
}

export function gridDisplay(input: StoredGridInput): GridDisplay {
  if (isCurrentGridInput(input)) {
    const axis = (side: AxisSide): CaseDisplay[] => {
      const kinds = axisParameters(input, side);
      return input[side].map((_, index) => {
        const parts = kinds.flatMap((kind) => {
          const value = parameterValue(
            input,
            kind,
            side === "rows" ? index : 0,
            side === "columns" ? index : 0,
          );
          return value === undefined ? [] : [part(kind, value)];
        });
        return {
          parts,
          downloadLabel: parts.length
            ? parts.map(downloadPart).filter(Boolean).join(" ")
            : `Case ${index + 1}`,
        };
      });
    };
    const common: ParameterDisplayPart[] = [];
    for (const kind of Object.keys(input.parameters) as ParameterId[]) {
      const source = input.parameters[kind];
      if (source?.kind === "common") common.push(part(kind, source.value));
    }
    return {
      rows: axis("rows"),
      columns: axis("columns"),
      common,
      promptImages: input.promptImages,
      references: selectedReferences(input),
    };
  }
  // Old offline API snapshots can precede the numbered-variable DB migration.
  // Normalize only this read projection, never stored metadata or an editor draft.
  const legacy = migrateVariableInput(input) as LegacyGridInput;
  const axes = [legacy.rows.kind, legacy.columns.kind];
  const axis = (side: AxisSide): CaseDisplay[] => {
    const axis = legacy[side];
    return axis.values.map((value, index) => {
      let displayPart: ParameterDisplayPart;
      if (axis.kind === "variable")
        displayPart = part("variable", axis.values[index]);
      else if (axis.kind === "input_references") {
        const name = axis.values[index];
        displayPart = {
          kind: "images",
          value: { name, images: legacy.referenceGroups?.[name] ?? [] },
        };
      } else if (axis.kind === "effort" || axis.kind === "judge_effort")
        displayPart = part(
          axis.kind,
          axis.values[index] as ParameterValues["effort"],
        );
      else displayPart = part(axis.kind, axis.values[index]);
      const parts = [displayPart];
      const criteria = legacy.judge?.criteria;
      if (criteria && !Array.isArray(criteria) && criteria.axis === side)
        parts.push(part("judge_criteria", criteria.cases[index] ?? []));
      const first = typeof value === "string" ? undefined : value[0];
      return {
        parts,
        // Historical filenames intentionally use only the first variable field.
        downloadLabel:
          typeof value === "string"
            ? value
            : first?.text ||
              first?.images?.map((image) => image.name).join(" ") ||
              "",
      };
    });
  };
  const common: ParameterDisplayPart[] = [];
  if (!axes.includes("model")) common.push(part("model", legacy.model));
  if (!axes.includes("effort") && legacy.format !== "image")
    common.push(part("effort", legacy.effort));
  if (legacy.format === "image")
    for (const kind of [
      "size",
      "aspect_ratio",
      "quality",
      "background",
    ] as const)
      if (!axes.includes(kind))
        common.push(part(kind, legacy.imageSettings?.[kind] || "auto"));
  if (legacy.judge) {
    if (!axes.includes("judge_model"))
      common.push(part("judge_model", legacy.judge.model));
    if (!axes.includes("judge_effort"))
      common.push(part("judge_effort", legacy.judge.effort));
    if (Array.isArray(legacy.judge.criteria))
      common.push(part("judge_criteria", legacy.judge.criteria));
  }
  return {
    rows: axis("rows"),
    columns: axis("columns"),
    common,
    promptImages:
      !axes.includes("input_references") && legacy.format !== "chat-template"
        ? (legacy.inputReferences ?? [])
        : [],
    references: selectedReferences(legacy),
  };
}

export function readGridCriteria(
  input: StoredGridInput,
  row: number,
  column: number,
): Criterion[] {
  return isCurrentGridInput(input)
    ? resolveCriteriaForCell(input, row, column, {
        allowUnresolvedVariables: true,
      }).criteria
    : resolveLegacyCriteriaForCell(
        migrateVariableInput(input) as LegacyGridInput,
        row,
        column,
        { allowUnresolvedVariables: true },
      ).criteria;
}
