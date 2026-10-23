import type { GridInput, ParameterValues } from "../server/domain.js";
import type { ReferenceImage } from "../server/image-settings.js";
import { selectedReferences } from "../server/image-settings.js";
import type { Criterion } from "../server/judge-criteria.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import {
  axisParameters,
  parameterValue,
  type AxisSide,
  type ParameterId,
  type CommonParameterId,
} from "../server/parameters.js";
import { generatorInputEntries } from "../server/generator-input.js";

export type ParameterDisplayPart = {
  [K in ParameterId]: { kind: K; value: ParameterValues[K] };
}[ParameterId];
export type CaseDisplay = {
  parts: ParameterDisplayPart[];
  downloadLabel: string;
};
export type GridDisplay = {
  rows: CaseDisplay[];
  columns: CaseDisplay[];
  common: ParameterDisplayPart[];
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
    case "input":
      return part.value.map((message) => message.content).join(" ");
    case "variable":
      return part.value
        .flatMap((field) =>
          field === null
            ? []
            : [
                field.text ||
                  field.images?.map((image) => image.name).join(" ") ||
                  "",
              ],
        )
        .join(" ");
    case "judge_criteria":
      return part.value.map((criterion) => criterion.text).join(" ");
    default:
      return part.value;
  }
}

export function gridDimensions(input: GridInput): {
  rows: number;
  columns: number;
} {
  return { rows: input.rows.length, columns: input.columns.length };
}

export function gridDisplay(input: GridInput): GridDisplay {
  const axis = (side: AxisSide): CaseDisplay[] => {
    const kinds = axisParameters(input, side);
    return input[side].map((_, index) => {
      const parts = kinds.flatMap((kind) => {
        const value = parameterValue(
          input,
          kind,
          side === "rows" ? index : 0,
          side === "columns" ? index : 0,
          side,
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
  for (const kind of Object.keys(input.parameters) as CommonParameterId[]) {
    const source = input.parameters[kind];
    if (source?.kind === "common") common.push(part(kind, source.value));
  }
  return {
    rows: axis("rows"),
    columns: axis("columns"),
    common,
    references: selectedReferences(input),
  };
}

export function readGridCriteria(
  input: GridInput,
  row: number,
  column: number,
): Criterion[] {
  return resolveCriteriaForCell(input, row, column, {
    allowUnresolvedVariables: true,
  }).criteria;
}

export function gridInputText(input: GridInput): string {
  return generatorInputEntries(input)
    .map(({ source, caseIndex, messages }) => {
      const text =
        input.format === "chat-template"
          ? messages
              .map(({ role, content }) => `${role}: ${content}`)
              .join("\n\n")
          : (messages[0]?.content ?? "");
      return source === "common"
        ? text
        : `${source === "rows" ? "Row" : "Column"} case ${(caseIndex ?? 0) + 1}:\n${text}`;
    })
    .join("\n\n");
}
