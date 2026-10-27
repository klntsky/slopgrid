import type {
  Cell,
  GenerationTask,
  Grid,
  ValidatedGridInput,
  JudgmentTask,
  WorkflowTask,
} from "./domain.js";
import { token } from "./ids.js";
import { generationPartitionKey } from "../shared/generation-key.js";
import { resolveCriteriaForCell } from "./judge-criteria.js";
import {
  createVariableIndex,
  interpolateVariables,
  type VariableIndex,
} from "./prompt-variables.js";
import { parameterValue } from "./parameters.js";

export function createWorkflow(
  input: ValidatedGridInput,
  cells: Cell[],
): WorkflowTask[] {
  const tasks: WorkflowTask[] = [];
  const groups = new Map<string, GenerationTask>();
  let variableIndex: VariableIndex | undefined;
  for (const cell of cells) {
    const key = generationPartitionKey(input.format, cell);
    let generation = groups.get(key);
    if (!generation) {
      generation = {
        id: token(),
        kind: "generation",
        status: "pending",
        input: {
          format: input.format,
          model: cell.model,
          effort: cell.effort,
          prompt: cell.prompt,
          messages: cell.messages,
          budgetUsd: cell.budgetUsd,
          imageSettings: cell.imageSettings,
        },
      };
      tasks.push(generation);
      groups.set(key, generation);
    }
    cell.generationId = generation.id;
    if (cell.judge && input.judge) {
      variableIndex ??= createVariableIndex(input);
      const { criteria, images } = resolveCriteriaForCell(
        input,
        cell.row,
        cell.column,
        { variableIndex },
      );
      const judgment: JudgmentTask = {
        id: token(),
        kind: "judge",
        generationId: generation.id,
        status: "pending",
        input: {
          model: cell.judge.model,
          effort: cell.judge.effort,
          systemPrompt: interpolateVariables(
            parameterValue(input, "judge_system", cell.row, cell.column)!,
            input,
            cell.row,
            cell.column,
            { variableIndex },
          ).text,
          criteria,
          ...(images ? { images } : {}),
        },
      };
      tasks.push(judgment);
      cell.judgmentId = judgment.id;
    } else delete cell.judgmentId;
  }
  return tasks;
}

// Cells are views of task state. Execution never writes state back through them.
export function projectWorkflow(
  grid: Grid,
  tasks: readonly WorkflowTask[],
): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const cell of grid.cells) {
    const generation = cell.generationId
      ? byId.get(cell.generationId)
      : undefined;
    if (generation?.kind !== "generation")
      throw new Error("A cell must reference its generation task.");
    const judgment = cell.judgmentId ? byId.get(cell.judgmentId) : undefined;
    if (
      cell.judgmentId &&
      (judgment?.kind !== "judge" || judgment.generationId !== generation.id)
    )
      throw new Error("A cell must reference a judgment of its generation.");
    const judge = judgment?.kind === "judge" ? judgment : undefined;
    const { input, output, progress } = generation;
    cell.model = input.model;
    cell.effort = input.effort;
    cell.prompt = input.prompt;
    cell.messages = input.messages;
    cell.budgetUsd = input.budgetUsd;
    cell.imageSettings = input.imageSettings;
    cell.status =
      generation.status === "complete" && output
        ? (judge?.status ?? "complete")
        : generation.status;
    cell.attemptId = generation.attemptId;
    cell.error = generation.error;
    cell.errorCode = generation.errorCode;
    cell.retrying = generation.retrying;
    cell.artifactId = output?.artifactId;
    cell.provenance = output?.provenance;
    cell.mediaType = output?.mediaType;
    cell.usage = output?.usage ?? progress?.usage;
    cell.thinkingId = progress?.thinkingId ?? output?.thinkingId;
    cell.thinkingSourceId =
      progress?.thinkingSourceId ?? output?.thinkingSourceId;
    cell.thinking = progress?.thinking;
    cell.draft = progress?.draft;
    cell.preview = progress?.preview;
    cell.estimatedUsage = progress?.estimatedUsage;
    cell.currentCallCostUsd = progress?.currentCallCostUsd;
    cell.judge = judge
      ? {
          model: judge.input.model,
          effort: judge.input.effort,
          criteria: judge.input.criteria,
          status: judge.status,
          attemptId: judge.attemptId,
          error: judge.error,
          errorCode: judge.errorCode,
          retrying: judge.retrying,
          results: judge.output?.results,
        }
      : undefined;
  }
}
