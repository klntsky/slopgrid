import type {
  CaseRecord,
  GridDraftInput,
  GridInput,
  ParameterValues,
} from "./domain.js";

export type ParameterId = keyof ParameterValues;
export type CommonParameterId = Exclude<ParameterId, "variable">;
export type AxisSide = "rows" | "columns";
export type ParameterConfiguration = Pick<
  GridInput,
  "parameters" | "rows" | "columns"
>;
export const parameterNames: Record<ParameterId, string> = {
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
    input.inputVersion === 2
  );
}

export function axisParameters(
  input: Pick<ParameterConfiguration, "parameters">,
  side: AxisSide,
): ParameterId[] {
  return (Object.keys(input.parameters) as ParameterId[]).filter(
    (kind) => input.parameters[kind]?.kind === side,
  );
}

const defaultValues: ParameterValues = {
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
    inputVersion: 2,
    format,
    prompt: "",
    promptImages: [],
    budgetUsd: "3",
    judge: false,
    ...(format === "chat-template"
      ? { messages: [{ role: "user", content: "" }] }
      : {}),
    parameters: {
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
