import type { GridInput } from "../../server/domain";
import type { Criterion } from "../../server/judge-criteria";

type Side = "rows" | "columns";
const copyRubric = (criteria: Criterion[]): Criterion[] =>
  criteria.map((criterion) => ({ ...criterion }));

export function makeJudgeVariable(input: GridInput, side: Side): GridInput {
  const axis = input[side];
  const judge = input.judge;
  if (!judge || axis.kind !== "variable" || !axis.values.length) return input;
  const source = judge.criteria;
  if (!Array.isArray(source)) return input;
  return {
    ...input,
    judge: {
      ...judge,
      criteria: {
        axis: side,
        cases: axis.values.map(() => copyRubric(source)),
      },
    },
  };
}

export function makeJudgeShared(
  input: GridInput,
  caseIndex: number,
): GridInput {
  const judge = input.judge;
  if (!judge || Array.isArray(judge.criteria)) return input;
  const rubric = judge.criteria.cases[caseIndex];
  if (!rubric) return input;
  return {
    ...input,
    judge: { ...judge, criteria: copyRubric(rubric) },
  };
}

export function addVariableCase(input: GridInput, side: Side): GridInput {
  const axis = input[side];
  if (axis.kind !== "variable") return input;
  const fields = axis.values[0]?.length ?? 1;
  const judge = input.judge;
  return {
    ...input,
    [side]: {
      ...axis,
      values: [
        ...axis.values,
        Array.from({ length: fields }, () => ({ text: "" })),
      ],
    },
    judge:
      judge && !Array.isArray(judge.criteria) && judge.criteria.axis === side
        ? {
            ...judge,
            criteria: {
              ...judge.criteria,
              cases: [
                ...judge.criteria.cases,
                [{ text: "", correctAnswer: true }],
              ],
            },
          }
        : judge,
  };
}

export function removeVariableCase(
  input: GridInput,
  side: Side,
  index: number,
): GridInput {
  const axis = input[side];
  if (
    axis.kind !== "variable" ||
    axis.values.length <= 1 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= axis.values.length
  )
    return input;
  const judge = input.judge;
  return {
    ...input,
    [side]: { ...axis, values: axis.values.filter((_, i) => i !== index) },
    judge:
      judge && !Array.isArray(judge.criteria) && judge.criteria.axis === side
        ? {
            ...judge,
            criteria: {
              ...judge.criteria,
              cases: judge.criteria.cases.filter((_, i) => i !== index),
            },
          }
        : judge,
  };
}

export function swapVariableTokens(text: string): string {
  return text.replace(
    /\$(ROW|COLUMN)([1-9]\d*)(?![\p{L}\p{N}_])/gu,
    (_, axis: string, number: string) =>
      `$${axis === "ROW" ? "COLUMN" : "ROW"}${number}`,
  );
}

export function swapJudgeAxes(judge: GridInput["judge"]): GridInput["judge"] {
  if (!judge) return judge;
  const swapRubric = (criteria: Criterion[]) =>
    criteria.map((criterion) => ({
      ...criterion,
      text: swapVariableTokens(criterion.text),
    }));
  return {
    ...judge,
    criteria: Array.isArray(judge.criteria)
      ? swapRubric(judge.criteria)
      : {
          axis: judge.criteria.axis === "rows" ? "columns" : "rows",
          cases: judge.criteria.cases.map(swapRubric),
        },
  };
}
