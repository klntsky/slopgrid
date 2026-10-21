import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaSets } from "./judge-criteria.js";

export type VariableField = { text: string; images?: ReferenceImage[] };
type VariableInput = Pick<GridInput, "rows" | "columns">;
type TemplateInput = VariableInput &
  Pick<GridInput, "prompt" | "messages" | "judge" | "format">;

// A numbered token or bare legacy token must end at a whole-word boundary.
export const variableToken = /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu;

export function mergeVariableImages(
  ...groups: (readonly ReferenceImage[] | undefined)[]
): ReferenceImage[] | undefined {
  const seen = new Set<string>();
  const images: ReferenceImage[] = [];
  for (const group of groups)
    for (const image of group ?? [])
      if (!seen.has(image.id)) {
        seen.add(image.id);
        images.push(image);
      }
  return images.length ? images : undefined;
}

export function referencedVariableImages(
  text: string,
  input: VariableInput,
  selection?: Partial<Record<"rows" | "columns", number>>,
): ReferenceImage[] {
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  for (const [, name, number] of text.matchAll(variableToken)) {
    const side = name === "ROW" ? "rows" : "columns";
    const axis = input[side];
    if (axis.kind !== "variable" || !/^[1-9]\d*$/.test(number)) continue;
    const index = selection?.[side];
    const values =
      index === undefined ? axis.values : [axis.values[index] ?? []];
    for (const fields of values)
      for (const image of fields[Number(number) - 1]?.images ?? [])
        if (!seen.has(image.id)) {
          seen.add(image.id);
          images.push(image);
        }
  }
  return images;
}

export type VariableInterpolationOptions = {
  allowUnresolvedVariables?: boolean;
};

export function interpolateVariables(
  text: string,
  input: VariableInput,
  row: number,
  column: number,
  options: VariableInterpolationOptions = {},
): { text: string; images?: ReferenceImage[] } {
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(
    variableToken,
    (token, name: string, number: string) => {
      const axis = name === "ROW" ? input.rows : input.columns;
      const index = name === "ROW" ? row : column;
      if (axis.kind !== "variable" || !/^[1-9]\d*$/.test(number)) {
        if (options.allowUnresolvedVariables) return token;
        throw new Error(`Invalid prompt variable ${token}.`);
      }
      const field = axis.values[index]?.[Number(number) - 1];
      if (!field) {
        if (options.allowUnresolvedVariables) return token;
        throw new Error(`Missing prompt variable ${token}.`);
      }
      for (const image of field.images ?? [])
        if (!seen.has(image.id)) {
          seen.add(image.id);
          images.push(image);
        }
      return field.text;
    },
  );
  return { text: expanded, ...(images.length ? { images } : {}) };
}

export function promptVariableIssue(input: TemplateInput): string | undefined {
  for (const axis of [input.rows, input.columns])
    if (
      axis.kind === "variable" &&
      (!axis.values.length ||
        !axis.values[0].length ||
        axis.values.some((fields) => fields.length !== axis.values[0].length))
    )
      return "Variable values must have the same nonzero number of fields.";
  const templates: { text: string; role: string }[] =
    input.format === "chat-template"
      ? (input.messages ?? []).map((message) => ({
          text: message.content,
          role: message.role,
        }))
      : [{ text: input.prompt, role: "user" }];
  templates.push(
    ...criteriaSets(input.judge?.criteria)
      .flat()
      .map(({ text }) => ({
        text,
        role: "user",
      })),
  );
  const used = new Set<string>();
  const source = input.judge?.criteria;
  if (source && !Array.isArray(source))
    used.add(source.axis === "rows" ? "ROW" : "COLUMN");
  for (const { text, role } of templates)
    for (const match of text.matchAll(variableToken)) {
      const [token, name, number] = match;
      const axis = name === "ROW" ? input.rows : input.columns;
      if (axis.kind !== "variable")
        return `Choose prompt variables for ${name === "ROW" ? "rows" : "columns"} to use ${token}.`;
      if (!/^[1-9]\d*$/.test(number) || Number(number) > axis.values[0].length)
        return `Unknown prompt variable ${token}.`;
      if (
        role !== "user" &&
        axis.values.some((fields) => fields[Number(number) - 1]?.images?.length)
      )
        return "Variable images can only be attached to user messages.";
      used.add(name);
    }
  for (const [name, axis] of [
    ["ROW", input.rows],
    ["COLUMN", input.columns],
  ] as const)
    if (axis.kind === "variable" && !used.has(name))
      return `Include $${name}1 in the prompt or judge criteria for ${name === "ROW" ? "row" : "column"} variables.`;
}
