import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaSets } from "./judge-criteria.js";
import { type ParameterConfiguration } from "./parameters.js";

export type VariableField = { text: string; images?: ReferenceImage[] };
type VariableInput = ParameterConfiguration;
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
    if (input.parameters.variable?.kind !== side || !/^[1-9]\d*$/.test(number))
      continue;
    const index = selection?.[side];
    const values = index === undefined ? axis : [axis[index]];
    for (const record of values)
      for (const image of record?.variable?.[Number(number) - 1]?.images ?? [])
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
      const side = name === "ROW" ? "rows" : "columns";
      const axis = input[side];
      const index = name === "ROW" ? row : column;
      if (
        input.parameters.variable?.kind !== side ||
        !/^[1-9]\d*$/.test(number)
      ) {
        if (options.allowUnresolvedVariables) return token;
        throw new Error(`Invalid prompt variable ${token}.`);
      }
      const field = axis[index]?.variable?.[Number(number) - 1];
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
  for (const side of ["rows", "columns"] as const) {
    if (input.parameters.variable?.kind !== side) continue;
    const cases = input[side];
    const count = cases[0]?.variable?.length;
    if (
      !cases.length ||
      !count ||
      cases.some((record) => record.variable?.length !== count)
    )
      return "Variable values must have the same nonzero number of fields.";
  }
  const templates: { text: string; role: string }[] =
    input.format === "chat-template"
      ? (input.messages ?? []).map((message) => ({
          text: message.content,
          role: message.role,
        }))
      : [{ text: input.prompt, role: "user" }];
  templates.push(
    ...criteriaSets(input)
      .flat()
      .map(({ text }) => ({
        text,
        role: "user",
      })),
  );
  const used = new Set<string>();
  for (const { text, role } of templates)
    for (const match of text.matchAll(variableToken)) {
      const [token, name, number] = match;
      const side = name === "ROW" ? "rows" : "columns";
      const axis = input[side];
      if (input.parameters.variable?.kind !== side)
        return `Choose prompt variables for ${name === "ROW" ? "rows" : "columns"} to use ${token}.`;
      if (
        !/^[1-9]\d*$/.test(number) ||
        Number(number) > (axis[0]?.variable?.length ?? 0)
      )
        return `Unknown prompt variable ${token}.`;
      if (
        role !== "user" &&
        axis.some(
          (record) => record.variable?.[Number(number) - 1]?.images?.length,
        )
      )
        return "Variable images can only be attached to user messages.";
      used.add(name);
    }
  for (const [name, side] of [
    ["ROW", "rows"],
    ["COLUMN", "columns"],
  ] as const)
    if (input.parameters.variable?.kind === side && !used.has(name))
      return `Include $${name}1 in the prompt or judge criteria for ${name === "ROW" ? "row" : "column"} variables.`;
}
