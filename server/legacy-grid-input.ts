import type { Cell, ChatMessage, Effort } from "./domain.js";
import type { ImageSettings, ReferenceImage } from "./image-settings.js";
import type { Criterion } from "./judge-criteria.js";

export type LegacyGridAxis =
  | { kind: "variable"; values: [{ text: string }][] }
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
// Master stored one text value per variable case and text-only Chat messages.
export type LegacyGridInput = {
  inputVersion?: undefined;
  format: "svg" | "markdown" | "html" | "chat-template" | "image";
  prompt: string;
  messages?: Pick<ChatMessage, "role" | "content">[];
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

const legacyVariableToken = /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu;

export function interpolateLegacyVariables(
  text: string,
  input: Pick<LegacyGridInput, "rows" | "columns">,
  row: number,
  column: number,
): string {
  return text.replace(
    legacyVariableToken,
    (token, name: string, number: string) => {
      const axis = name === "ROW" ? input.rows : input.columns;
      const index = name === "ROW" ? row : column;
      if (axis.kind !== "variable" || number !== "1")
        throw new Error(`Invalid prompt variable ${token}.`);
      const field = axis.values[index]?.[0];
      if (!field) throw new Error(`Missing prompt variable ${token}.`);
      return field.text;
    },
  );
}

export function legacySelectedReferences(
  input: LegacyGridInput,
): ReferenceImage[] {
  if (input.format !== "image") return [];
  const axis = [input.rows, input.columns].find(
    (axis) => axis.kind === "input_references",
  );
  const references =
    axis?.kind === "input_references"
      ? axis.values.flatMap((name) => input.referenceGroups?.[name] ?? [])
      : (input.inputReferences ?? []);
  const seen = new Set<string>();
  return references.filter((image) => {
    if (seen.has(image.id)) return false;
    seen.add(image.id);
    return true;
  });
}

function normalizeLegacyImageSettings(settings: ImageSettings): ImageSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : !!value && value !== "auto",
    ),
  );
}

// Frozen pre-v14 migration semantics. Ordinary reads project accepted tasks.
export function expandLegacyGrid(input: LegacyGridInput): Omit<Cell, "id">[] {
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
      const messages = input.messages?.map(({ role, content }) => ({
        role,
        content: interpolateLegacyVariables(content, input, row, column),
      }));
      const prompt = messages
        ? messages
            .map(({ role, content }) => `${role}: ${content}`)
            .join("\n\n")
        : interpolateLegacyVariables(input.prompt, input, row, column);
      return {
        row,
        column,
        ...selections,
        prompt,
        ...(messages ? { messages } : {}),
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
