import type { Cell, ChatMessage, Effort, VariableField } from "./domain.js";
import type { ImageSettings, ReferenceImage } from "./image-settings.js";
import type { Criterion } from "./judge-criteria.js";

export type LegacyGridAxis =
  | { kind: "variable"; values: VariableField[][] }
  | {
      kind:
        | "model"
        | "effort"
        | "judge_model"
        | "judge_effort"
        | "size"
        | "aspect_ratio"
        | "quality"
        | "background"
        | "input_references";
      values: string[];
    };

// Persisted metadata only. This is deliberately not an admission/editor schema.
export type LegacyGridInput = {
  inputVersion?: undefined;
  format: "svg" | "markdown" | "html" | "chat-template" | "image";
  prompt: string;
  messages?: ChatMessage[];
  rows: LegacyGridAxis;
  columns: LegacyGridAxis;
  imageSettings?: Omit<ImageSettings, "input_references">;
  inputReferences?: ReferenceImage[];
  referenceGroups?: Record<string, ReferenceImage[]>;
  model: string;
  effort: Effort;
  judge?: { criteria: Criterion[]; model: string; effort: Effort };
  parallelWorkers?: number;
  budgetUsd: number;
};

export const legacyVariableToken = /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu;
type LegacyVariableInput = Pick<LegacyGridInput, "rows" | "columns">;
export type LegacyInterpolationOptions = { allowUnresolvedVariables?: boolean };

function mergeImages(
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

export function interpolateLegacyVariables(
  text: string,
  input: LegacyVariableInput,
  row: number,
  column: number,
  options: LegacyInterpolationOptions = {},
): { text: string; images?: ReferenceImage[] } {
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(
    legacyVariableToken,
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

export function resolveLegacyCriteriaForCell(
  input: Pick<LegacyGridInput, "judge" | "rows" | "columns">,
  row: number,
  column: number,
  options: LegacyInterpolationOptions = {},
): { criteria: Criterion[]; images?: ReferenceImage[] } {
  let images: ReferenceImage[] | undefined;
  const criteria = (input.judge?.criteria ?? []).map((criterion) => {
    const expanded = interpolateLegacyVariables(
      criterion.text,
      input,
      row,
      column,
      options,
    );
    images = mergeImages(images, expanded.images);
    return { ...criterion, text: expanded.text };
  });
  return { criteria, ...(images ? { images } : {}) };
}

export function legacySelectedReferences(
  input: LegacyGridInput,
): ReferenceImage[] {
  const axis = [input.rows, input.columns].find(
    (axis) => axis.kind === "input_references",
  );
  const explicit =
    input.format === "chat-template"
      ? input.messages?.flatMap((message) => message.images ?? [])
      : axis?.kind === "input_references"
        ? axis.values.flatMap((name) => input.referenceGroups?.[name] ?? [])
        : input.inputReferences;
  return (
    mergeImages(
      explicit,
      input.messages?.flatMap((message) => message.images ?? []),
      ...[input.rows, input.columns].flatMap((axis) =>
        axis.kind === "variable"
          ? axis.values.flatMap((fields) => fields.map((field) => field.images))
          : [],
      ),
    ) ?? []
  );
}

export function mapLegacyReferences<T extends LegacyGridInput>(
  input: T,
  hydrate: (image: ReferenceImage) => ReferenceImage,
): T {
  const axis = (axis: LegacyGridAxis): LegacyGridAxis =>
    axis.kind === "variable"
      ? {
          ...axis,
          values: axis.values.map((fields) =>
            fields.map((field) =>
              field.images
                ? { ...field, images: field.images.map(hydrate) }
                : field,
            ),
          ),
        }
      : axis;
  return {
    ...input,
    rows: axis(input.rows),
    columns: axis(input.columns),
    ...(input.messages
      ? {
          messages: input.messages.map((message) =>
            message.images
              ? { ...message, images: message.images.map(hydrate) }
              : message,
          ),
        }
      : {}),
    ...(input.inputReferences
      ? { inputReferences: input.inputReferences.map(hydrate) }
      : {}),
    ...(input.referenceGroups
      ? {
          referenceGroups: Object.fromEntries(
            Object.entries(input.referenceGroups).map(([name, images]) => [
              name,
              images.map(hydrate),
            ]),
          ),
        }
      : {}),
  };
}

function normalizeLegacyImageSettings(settings: ImageSettings): ImageSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : !!value && value !== "auto",
    ),
  );
}

// Frozen pre-v14 migration semantics. Ordinary reads project accepted tasks.
export function expandLegacyGrid(
  input: LegacyGridInput,
  options: LegacyInterpolationOptions = {},
): Omit<Cell, "id">[] {
  return input.rows.values.flatMap((_, row) =>
    input.columns.values.map((_, column) => {
      const selections = { model: input.model, effort: input.effort as string };
      const judge: Cell["judge"] = input.judge
        ? {
            model: input.judge.model,
            effort: input.judge.effort,
            status: "pending",
          }
        : undefined;
      const imageSettings: ImageSettings = { ...input.imageSettings };
      if (input.format === "image" && input.inputReferences?.length)
        imageSettings.input_references = input.inputReferences.map(
          (image) => image.id,
        );
      for (const [axis, index] of [
        [input.rows, row],
        [input.columns, column],
      ] as const) {
        if (axis.kind === "variable") continue;
        const value = axis.values[index];
        if (axis.kind === "model" || axis.kind === "effort")
          selections[axis.kind] = value;
        else if (axis.kind === "judge_model" || axis.kind === "judge_effort") {
          if (judge) {
            if (axis.kind === "judge_model") judge.model = value;
            else judge.effort = value;
          }
        } else if (axis.kind === "input_references")
          imageSettings.input_references =
            input.referenceGroups?.[value]?.map((image) => image.id) ?? [];
        else imageSettings[axis.kind] = value;
      }
      const messages = input.messages?.map((message) => {
        const content = interpolateLegacyVariables(
          message.content,
          input,
          row,
          column,
          options,
        );
        const images = mergeImages(message.images, content.images);
        return {
          ...message,
          content: content.text,
          ...(images ? { images } : {}),
        };
      });
      const expanded = messages
        ? {
            text: messages
              .map(({ role, content }) => `${role}: ${content}`)
              .join("\n\n"),
            images: undefined,
          }
        : interpolateLegacyVariables(input.prompt, input, row, column, options);
      if (input.format === "image" && expanded.images)
        imageSettings.input_references = [
          ...new Set([
            ...(imageSettings.input_references ?? []),
            ...expanded.images.map((image) => image.id),
          ]),
        ];
      const images =
        input.format !== "image" && !messages
          ? input.inputReferences?.length
            ? mergeImages(input.inputReferences, expanded.images)
            : expanded.images
          : undefined;
      return {
        row,
        column,
        ...selections,
        prompt: expanded.text,
        ...(messages ? { messages } : {}),
        ...(images ? { images } : {}),
        budgetUsd: input.budgetUsd,
        ...(input.format === "image"
          ? { imageSettings: normalizeLegacyImageSettings(imageSettings) }
          : {}),
        status: "pending" as const,
        ...(judge ? { judge } : {}),
      };
    }),
  );
}
