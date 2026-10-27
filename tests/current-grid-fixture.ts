import {
  gridSchema,
  type CaseRecord,
  type GridInput,
  type ParameterSources,
  type ParameterValues,
} from "../server/domain.js";
import {
  parameterDefault,
  type CommonParameterId,
} from "../server/parameters.js";
import type { Model } from "../server/provider.js";

const textFixtureModels: Model[] = [
  "fixture/text",
  "fixture/judge",
  "fixture/one",
  "fixture/two",
  "fixture/other",
  "fixture/unpriced",
  "fixture/generator",
  "generator",
  "generator-a",
  "generator-b",
  "judge",
  "judge-a",
  "judge-b",
  "actual-judge",
  "free-judge",
  "example/model",
  "cheap",
].map((id) => ({
  id,
  name: `Text fixture ${id}`,
  image: false,
  imageInput: true,
  text: true,
  reasoning: true,
  reasoningMandatory: false,
  structuredOutputs: true,
}));

export const fixtureModels: ReadonlyMap<string, Model> = new Map(
  [
    ...textFixtureModels,
    {
      id: "fixture/multimodal",
      name: "Fixture multimodal",
      image: false,
      imageInput: true,
      text: true,
      chatImageOutput: true,
      reasoning: true,
      reasoningMandatory: false,
      structuredOutputs: true,
    },
    {
      id: "fixture/image",
      name: "Fixture image",
      image: true,
      imageInput: true,
      text: false,
      reasoning: false,
      reasoningMandatory: false,
    },
  ].map((model): [string, Model] => [model.id, model]),
);

type FixtureCases = (Partial<ParameterValues> & { id?: string })[];
export type CurrentGridOverrides = Omit<
  Partial<GridInput>,
  "parameters" | "rows" | "columns"
> & {
  parameters?: Partial<ParameterSources>;
  rows?: FixtureCases;
  columns?: FixtureCases;
};
function common<K extends CommonParameterId>(
  parameter: K,
  value: ParameterValues[K] = parameterDefault(parameter),
) {
  return { kind: "common" as const, value };
}
function cases(values: FixtureCases | undefined, prefix: string): CaseRecord[] {
  return (values ?? [{}]).map((value, index) => ({
    ...value,
    id: value.id ?? `${prefix}${index + 1}`,
  }));
}

// Current-format defaults only. Historical fixtures must arrange accepted storage directly.
export function currentDefinition(
  overrides: CurrentGridOverrides = {},
): GridInput {
  const format = overrides.format ?? "markdown";
  const parameters: ParameterSources = {
    input: common("input", [{ role: "user", content: "Draw a cat" }]),
    model: common(
      "model",
      format === "image" ? "fixture/image" : "fixture/text",
    ),
    ...(format === "image"
      ? {
          size: common("size"),
          aspect_ratio: common("aspect_ratio"),
          quality: common("quality"),
          background: common("background"),
        }
      : { effort: common("effort") }),
    ...(overrides.judge
      ? {
          judge_model: common("judge_model", "fixture/text"),
          judge_effort: common("judge_effort"),
          judge_system: common("judge_system"),
          judge_criteria: common("judge_criteria", [
            { text: "Is this a cat?", correctAnswer: true },
          ]),
        }
      : {}),
    ...overrides.parameters,
  };
  const definition = {
    inputVersion: 3 as const,
    budgetUsd: 3,
    judge: false,
    caseAxes: [],
    ...overrides,
    parameters,
    rows: cases(overrides.rows, "row-"),
    columns: cases(overrides.columns, "column-"),
  };
  return { ...definition, format };
}

export function currentInput(overrides: CurrentGridOverrides = {}) {
  return gridSchema.parse(currentDefinition(overrides));
}
