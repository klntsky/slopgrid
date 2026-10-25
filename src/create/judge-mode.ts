import type { CaseRecord, GridDraftInput } from "../../server/domain";
import { variableToken } from "../../server/prompt-variables";

export function referencedVariableNames(input: GridDraftInput): Set<string> {
  const names = new Set<string>();
  function read(text: string) {
    for (const match of text.matchAll(variableToken)) names.add(match[1]);
  }
  const generator = input.parameters.input;
  if (generator.kind === "common")
    for (const message of generator.value) read(message.content);
  const criteria = input.parameters.judge_criteria;
  if (criteria?.kind === "common")
    for (const criterion of criteria.value) read(criterion.text);
  for (const side of ["rows", "columns"] as const)
    for (const entry of input[side]) {
      for (const message of entry.input ?? []) read(message.content);
      for (const criterion of entry.judge_criteria ?? []) read(criterion.text);
    }
  return names;
}

export function rewriteVariableReferences(
  input: GridDraftInput,
  rename: (name: string) => string,
): GridDraftInput {
  const text = (value: string) =>
    value.replace(variableToken, (_, name: string) => `$${rename(name)}`);
  const cases = (entries: CaseRecord[]) =>
    entries.map((entry) => ({
      ...entry,
      ...(entry.input && {
        input: entry.input.map((message) => ({
          ...message,
          content: text(message.content),
        })),
      }),
      ...(entry.judge_criteria && {
        judge_criteria: entry.judge_criteria.map((criterion) => ({
          ...criterion,
          text: text(criterion.text),
        })),
      }),
    }));
  const parameters = { ...input.parameters };
  const generator = parameters.input;
  if (generator.kind === "common")
    parameters.input = {
      kind: "common",
      value: generator.value.map((message) => ({
        ...message,
        content: text(message.content),
      })),
    };
  const criteria = parameters.judge_criteria;
  if (criteria?.kind === "common")
    parameters.judge_criteria = {
      kind: "common",
      value: criteria.value.map((criterion) => ({
        ...criterion,
        text: text(criterion.text),
      })),
    };
  return {
    ...input,
    parameters,
    rows: cases(input.rows),
    columns: cases(input.columns),
  };
}
