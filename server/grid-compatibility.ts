import { expandGrid, type GridInput, type Cell } from "./domain.js";
import {
  effortLabel,
  imageSettingsSupport,
  judgeModelIssue,
  thinkingEffortSupport,
} from "./compatibility.js";
import { criteriaForCell, resolveCriteriaForCell } from "./judge-criteria.js";
import { referencedVariableFields } from "./prompt-variables.js";
import type { Model } from "./provider.js";
import { type CommonParameterId, type ParameterId } from "./parameters.js";
import { ModelResolutionError, modelAliasResolver } from "./model-alias.js";
import { generatorInputForCell } from "./generator-input.js";

type ScalarParameter = CommonParameterId;
export type CompatibilityParameter = ParameterId;
export type CompatibilityOrigin = {
  parameter: CompatibilityParameter;
  source: "common" | "rows" | "columns";
  caseIndex?: number;
  fieldIndex?: number;
  messageIndex?: number;
};
export type GridCompatibilityIssue = {
  row: number;
  column: number;
  parameters: CompatibilityParameter[];
  origins: CompatibilityOrigin[];
  support: "unsupported" | "unknown";
  blocking: boolean;
  reason: string;
};
type ExpandedCell = Omit<Cell, "id">;
export type GridCompatibilityAnalysis = {
  cells: ExpandedCell[];
  issues: GridCompatibilityIssue[];
};

function distinctOrigins(
  origins: CompatibilityOrigin[],
): CompatibilityOrigin[] {
  const seen = new Set<string>();
  return origins.filter((origin) => {
    const key = `${origin.parameter}:${origin.source}:${origin.caseIndex ?? ""}:${origin.fieldIndex ?? ""}:${origin.messageIndex ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scalarOrigin(
  input: GridInput,
  cell: ExpandedCell,
  parameter: ScalarParameter,
): CompatibilityOrigin {
  const source = input.parameters[parameter]?.kind ?? "common";
  return {
    parameter,
    source,
    ...(source === "common"
      ? {}
      : {
          caseIndex: source === "rows" ? cell.row : cell.column,
        }),
  };
}

// Origins are mapped only after expansion has identified consumed images.
function variableImageOrigins(
  text: string,
  input: GridInput,
  cell: ExpandedCell,
  consumed: ReadonlySet<string>,
): CompatibilityOrigin[] {
  const origins: CompatibilityOrigin[] = [];
  for (const { field, path } of referencedVariableFields(
    text,
    input,
    cell.row,
    cell.column,
  )) {
    if (field.images?.some((image) => consumed.has(image.id)))
      origins.push({
        parameter: "variable",
        source: path[0] as "rows" | "columns",
        caseIndex: path[1] as number,
        fieldIndex: path[3] as number,
      });
  }
  return distinctOrigins(origins);
}

function generatorImageContext(
  input: GridInput,
  cell: ExpandedCell,
): { consumed: Set<string>; origins: CompatibilityOrigin[] } {
  const consumed = new Set(
    cell.messages?.flatMap((message) =>
      (message.images ?? []).map((image) => image.id),
    ),
  );
  const origins: CompatibilityOrigin[] = [];
  const source = input.parameters.input.kind;
  generatorInputForCell(input, cell.row, cell.column).forEach(
    (message, messageIndex) => {
      const images = new Set(
        cell.messages?.[messageIndex]?.images?.map((image) => image.id),
      );
      if (!images.size) return;
      origins.push({
        parameter: "input",
        source,
        ...(source === "common"
          ? {}
          : { caseIndex: source === "rows" ? cell.row : cell.column }),
        messageIndex,
      });
      origins.push(
        ...variableImageOrigins(message.content, input, cell, images),
      );
    },
  );
  return { consumed, origins: distinctOrigins(origins) };
}

export function analyzeGridCompatibility(
  input: GridInput,
  models: readonly Model[],
  cells = expandGrid(input, { allowUnresolvedVariables: true }),
): GridCompatibilityAnalysis {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const resolve = modelAliasResolver(catalog);
  const issues: GridCompatibilityIssue[] = [];
  // Canonical admission validates tokens strictly. Advisory previews must still
  // expose known cell settings while unrelated draft templates are unfinished.
  const options = { allowUnresolvedVariables: true };
  for (const cell of cells) {
    let model: Model | undefined;
    let modelFailure: ModelResolutionError | undefined;
    try {
      model = catalog.get(resolve(cell.model));
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      modelFailure = error;
    }
    const generator = generatorImageContext(input, cell);
    function issue(
      origins: CompatibilityOrigin[],
      support: GridCompatibilityIssue["support"],
      blocking: boolean,
      reason: string,
      parameters: CompatibilityParameter[] = [],
    ) {
      origins = distinctOrigins(origins);
      issues.push({
        row: cell.row,
        column: cell.column,
        parameters: [
          ...new Set([...parameters, ...origins.map((o) => o.parameter)]),
        ],
        origins,
        support,
        blocking,
        reason,
      });
    }
    function effortIssue(
      selected: Model | undefined,
      effort: string,
      modelParameter: "model" | "judge_model",
      effortParameter: "effort" | "judge_effort",
    ) {
      const support = thinkingEffortSupport(selected, effort);
      if (support === "supported") return;
      issue(
        [
          scalarOrigin(input, cell, modelParameter),
          scalarOrigin(input, cell, effortParameter),
        ],
        support,
        false,
        support === "unknown"
          ? `Thinking effort ${effortLabel(effort)} support is unknown for ${selected?.name ?? (modelParameter === "model" ? cell.model : cell.judge?.model)}.`
          : `${selected?.name ?? "The selected model"} does not support thinking effort ${effortLabel(effort)}.`,
      );
    }
    if (modelFailure)
      issue(
        [scalarOrigin(input, cell, "model")],
        "unknown",
        true,
        modelFailure.message,
      );
    if (cell.model && !modelFailure) {
      if (generator.consumed.size && model?.imageInput !== true)
        issue(
          [scalarOrigin(input, cell, "model"), ...generator.origins],
          model?.imageInput === false ? "unsupported" : "unknown",
          true,
          model?.imageInput === false
            ? "The selected model does not support image inputs."
            : "The selected model's image input support is unverified.",
        );
      if (input.format !== "image")
        effortIssue(model, cell.effort, "model", "effort");
    }
    if (input.format === "image" && !modelFailure) {
      const compatibility = imageSettingsSupport(
        model?.imageEndpoints?.map((endpoint) => endpoint.supported_parameters),
        cell.imageSettings ?? {},
      );
      for (const conflict of compatibility.conflicts) {
        const origins = conflict.modelDependent
          ? [scalarOrigin(input, cell, "model")]
          : [];
        for (const parameter of conflict.parameters)
          if (parameter === "input_references")
            origins.push(...generator.origins);
          else origins.push(scalarOrigin(input, cell, parameter));
        issue(
          origins,
          conflict.support,
          false,
          conflict.reason,
          conflict.parameters.filter(
            (parameter) => parameter !== "input_references",
          ),
        );
      }
    }
    if (!cell.judge?.model) continue;
    let judge: Model | undefined;
    try {
      judge = catalog.get(resolve(cell.judge.model));
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      issue(
        [scalarOrigin(input, cell, "judge_model")],
        "unknown",
        true,
        error.message,
      );
      continue;
    }
    const resolvedCriteria = resolveCriteriaForCell(
      input,
      cell.row,
      cell.column,
      options,
    );
    const criterionImages = new Set(
      resolvedCriteria.images?.map((image) => image.id),
    );
    const judgeIssue = judgeModelIssue(
      judge,
      input.format,
      generator.consumed.size > 0 || criterionImages.size > 0,
    );
    if (judgeIssue) {
      const origins = [scalarOrigin(input, cell, "judge_model")];
      const needsVision =
        input.format !== "html" &&
        judge?.text === true &&
        judge.structuredOutputs === true;
      if (needsVision && input.format !== "svg" && input.format !== "image") {
        origins.push(...generator.origins);
        if (criterionImages.size) {
          origins.push(scalarOrigin(input, cell, "judge_criteria"));
          for (const criterion of criteriaForCell(input, cell.row, cell.column))
            origins.push(
              ...variableImageOrigins(
                criterion.text,
                input,
                cell,
                criterionImages,
              ),
            );
        }
      }
      const support =
        input.format === "html" ||
        (needsVision
          ? judge?.imageInput === false
          : judge?.text === false || judge?.structuredOutputs === false)
          ? "unsupported"
          : "unknown";
      issue(origins, support, true, judgeIssue);
    }
    effortIssue(judge, cell.judge.effort, "judge_model", "judge_effort");
  }
  return { cells, issues };
}
