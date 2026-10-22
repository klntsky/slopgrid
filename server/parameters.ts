import type {
  CaseRecord,
  GridDraftInput,
  GridInput,
  ParameterValues,
} from "./domain.js";
import type { Version2GridInput } from "./legacy-grid-input.js";

export type ParameterId = keyof ParameterValues;
export type CommonParameterId = Exclude<ParameterId, "variable">;
export type AxisSide = "rows" | "columns";
export type ParameterConfiguration = Pick<
  GridInput,
  "parameters" | "rows" | "columns" | "caseAxis"
>;
export const parameterNames: Record<ParameterId, string> = {
  input: "Generator input",
  model: "Model",
  effort: "Thinking effort",
  size: "Size",
  aspect_ratio: "Aspect ratio",
  quality: "Quality",
  background: "Background",
  judge_model: "Judge model",
  judge_effort: "Judge thinking effort",
  judge_criteria: "Judge criteria",
  variable: "Prompt variables",
};

export function isCurrentGridInput(input: unknown): input is GridInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "inputVersion" in input &&
    input.inputVersion === 3
  );
}

// Recognizing persisted metadata is separate from admitting an editable input.
export function isParameterGridInput(
  input: unknown,
): input is GridInput | Version2GridInput {
  return (
    isCurrentGridInput(input) ||
    (typeof input === "object" &&
      input !== null &&
      "inputVersion" in input &&
      input.inputVersion === 2)
  );
}

export function parameterReadConfiguration(
  input: GridInput | Version2GridInput,
): ParameterConfiguration {
  if (input.inputVersion === 3) return input;
  return {
    rows: input.rows,
    columns: input.columns,
    caseAxis: input.parameters.variable?.kind,
    parameters: {
      ...input.parameters,
      input: {
        kind: "common",
        value:
          input.format === "chat-template"
            ? (input.messages ?? [])
            : [
                {
                  role: "user",
                  content: input.prompt,
                  ...(input.promptImages.length
                    ? { images: input.promptImages }
                    : {}),
                },
              ],
      },
    },
  };
}

export function axisParameters(
  input: Pick<ParameterConfiguration, "parameters">,
  side: AxisSide,
): ParameterId[] {
  return (Object.keys(input.parameters) as ParameterId[]).filter(
    (kind) => input.parameters[kind]?.kind === side,
  );
}

export function parameterLayoutIssue(
  input: ParameterConfiguration,
): string | undefined {
  const variableSide = input.parameters.variable?.kind;
  if (variableSide && variableSide !== input.caseAxis)
    return "Numbered fields must belong to the case axis.";
  for (const side of ["rows", "columns"] as const) {
    const owned = axisParameters(input, side);
    if (input.caseAxis === side) continue;
    if (owned.length > 1) return "Only case axes can own multiple parameters.";
    if (owned.includes("judge_criteria") || owned.includes("input"))
      return "Per-case input and judge criteria require a case axis.";
    if (!owned.length && input[side].length !== 1)
      return `An axis with no parameters must have one neutral ${side} case.`;
  }
}

export function isEditableGridInput(input: unknown): input is GridInput {
  return isCurrentGridInput(input) && !parameterLayoutIssue(input);
}

const defaultValues: ParameterValues = {
  input: [{ role: "user", content: "" }],
  model: "",
  effort: "default",
  size: "auto",
  aspect_ratio: "auto",
  quality: "auto",
  background: "auto",
  judge_model: "",
  judge_effort: "default",
  judge_criteria: [{ text: "", correctAnswer: true }],
  variable: [{ text: "" }],
};

export function parameterDefault<K extends ParameterId>(
  kind: K,
): ParameterValues[K] {
  const value = defaultValues[kind];
  return typeof value === "object" ? structuredClone(value) : value;
}

export function parameterValue<K extends ParameterId>(
  input: ParameterConfiguration,
  kind: K,
  row: number,
  column: number,
): ParameterValues[K] | undefined {
  const source = input.parameters[kind];
  if (!source) return undefined;
  if (source.kind === "common") return source.value as ParameterValues[K];
  const record: Partial<ParameterValues> | undefined =
    input[source.kind][source.kind === "rows" ? row : column];
  return record?.[kind];
}

export function newCase(values: Partial<ParameterValues> = {}): CaseRecord {
  return { ...values, id: globalThis.crypto.randomUUID() };
}

export function defaultGridDraft(format: GridInput["format"]): GridDraftInput {
  const image = format === "image";
  const modelRows = image || format === "svg" || format === "html";
  return {
    inputVersion: 3,
    format,
    budgetUsd: "3",
    judge: false,
    parameters: {
      input: { kind: "common", value: parameterDefault("input") },
      model: { kind: modelRows ? "rows" : "columns" },
      ...(image
        ? {
            quality: { kind: "columns" as const },
            size: { kind: "common" as const, value: "auto" },
            aspect_ratio: { kind: "common" as const, value: "auto" },
            background: { kind: "common" as const, value: "auto" },
          }
        : {
            effort: {
              kind: modelRows ? ("columns" as const) : ("rows" as const),
            },
          }),
    },
    rows: modelRows ? [] : [newCase({ effort: "default" })],
    columns: modelRows
      ? [newCase(image ? { quality: "auto" } : { effort: "default" })]
      : [],
  };
}
