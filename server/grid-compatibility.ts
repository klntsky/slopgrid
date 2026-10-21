import {
  expandGrid,
  type GridInput,
  type GridAxis,
  type Cell,
} from "./domain.js";
import {
  effortLabel,
  imageSettingsSupport,
  judgeModelIssue,
  thinkingEffortSupport,
} from "./compatibility.js";
import { criteriaForCell, resolveCriteriaForCell } from "./judge-criteria.js";
import { variableToken } from "./prompt-variables.js";
import type { Model } from "./provider.js";

type ScalarParameter = Exclude<GridAxis["kind"], "variable">;
export type CompatibilityParameter =
  ScalarParameter | "judge_criteria" | "variable" | "prompt" | "messages";
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
  for (const source of ["rows", "columns"] as const)
    if (input[source].kind === parameter)
      return {
        parameter,
        source,
        caseIndex: source === "rows" ? cell.row : cell.column,
      };
  return { parameter, source: "common" };
}

function criteriaOrigin(
  input: GridInput,
  cell: ExpandedCell,
): CompatibilityOrigin {
  const criteria = input.judge?.criteria;
  return criteria && !Array.isArray(criteria)
    ? {
        parameter: "judge_criteria",
        source: criteria.axis,
        caseIndex: criteria.axis === "rows" ? cell.row : cell.column,
      }
    : { parameter: "judge_criteria", source: "common" };
}

// Origins are mapped only after expansion has identified consumed images.
function variableImageOrigins(
  text: string,
  input: GridInput,
  cell: ExpandedCell,
  consumed: ReadonlySet<string>,
): CompatibilityOrigin[] {
  const origins: CompatibilityOrigin[] = [];
  for (const [, name, number] of text.matchAll(variableToken)) {
    if (!/^[1-9]\d*$/.test(number)) continue;
    const source = name === "ROW" ? "rows" : "columns";
    const axis = input[source];
    const caseIndex = source === "rows" ? cell.row : cell.column;
    const fieldIndex = Number(number) - 1;
    if (
      axis.kind === "variable" &&
      axis.values[caseIndex]?.[fieldIndex]?.images?.some((image) =>
        consumed.has(image.id),
      )
    )
      origins.push({ parameter: "variable", source, caseIndex, fieldIndex });
  }
  return distinctOrigins(origins);
}

function generatorImageContext(
  input: GridInput,
  cell: ExpandedCell,
): { consumed: Set<string>; origins: CompatibilityOrigin[] } {
  const consumed = new Set(
    cell.messages
      ? cell.messages.flatMap((message) =>
          (message.images ?? []).map((image) => image.id),
        )
      : input.format === "image"
        ? (cell.imageSettings?.input_references ?? [])
        : (cell.images ?? []).map((image) => image.id),
  );
  const origins: CompatibilityOrigin[] = [];
  if (cell.messages) {
    input.messages?.forEach((message, messageIndex) => {
      const images = new Set(
        cell.messages?.[messageIndex]?.images?.map((image) => image.id),
      );
      if (!images.size) return;
      origins.push({ parameter: "messages", source: "common", messageIndex });
      origins.push(
        ...variableImageOrigins(message.content, input, cell, images),
      );
    });
  } else {
    const origin = scalarOrigin(input, cell, "input_references");
    const source = origin.source;
    const axis = source === "common" ? undefined : input[source];
    const references =
      axis?.kind === "input_references"
        ? input.referenceGroups?.[axis.values[origin.caseIndex ?? 0]]
        : input.inputReferences;
    if (references?.some((image) => consumed.has(image.id))) {
      origins.push(origin);
      if (input.format !== "image")
        origins.push({ parameter: "prompt", source: "common" });
    }
    const variables = variableImageOrigins(input.prompt, input, cell, consumed);
    if (variables.length)
      origins.push({ parameter: "prompt", source: "common" }, ...variables);
  }
  return { consumed, origins: distinctOrigins(origins) };
}

export function analyzeGridCompatibility(
  input: GridInput,
  models: readonly Model[],
): GridCompatibilityAnalysis {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const issues: GridCompatibilityIssue[] = [];
  // Canonical admission validates tokens strictly. Advisory previews must still
  // expose known cell settings while unrelated draft templates are unfinished.
  const options = { allowUnresolvedVariables: true };
  const cells = expandGrid(input, options);
  for (const cell of cells) {
    const model = catalog.get(cell.model);
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
    if (cell.model) {
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
    if (input.format === "image") {
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
            origins.push(
              ...(generator.origins.length
                ? generator.origins
                : [scalarOrigin(input, cell, parameter)]),
            );
          else origins.push(scalarOrigin(input, cell, parameter));
        issue(
          origins,
          conflict.support,
          false,
          conflict.reason,
          conflict.parameters,
        );
      }
    }
    if (!cell.judge?.model) continue;
    const judge = catalog.get(cell.judge.model);
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
      if (needsVision) {
        origins.push(...generator.origins);
        if (criterionImages.size) {
          origins.push(criteriaOrigin(input, cell));
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
