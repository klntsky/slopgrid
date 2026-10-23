import type { ChatMessage } from "./domain.js";
import {
  parameterValue,
  type AxisSide,
  type ParameterConfiguration,
} from "./parameters.js";

export function generatorInputForCell(
  input: ParameterConfiguration,
  row: number,
  column: number,
): ChatMessage[] {
  return parameterValue(input, "input", row, column) ?? [];
}

export function generatorInputEntries(input: ParameterConfiguration): {
  source: "common" | AxisSide;
  caseIndex?: number;
  messages: ChatMessage[];
}[] {
  const source = input.parameters.input;
  if (source.kind === "common")
    return [{ source: "common", messages: source.value }];
  const side = source.kind;
  return input[side].map((record, caseIndex) => ({
    source: side,
    caseIndex,
    messages: record.input ?? [],
  }));
}
