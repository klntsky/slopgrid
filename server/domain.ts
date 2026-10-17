import { z } from "zod";
import {
  imageKinds,
  validImageSetting,
  sharedImageSettingsSchema,
  normalizeImageSettings,
  type ScalarImageKind,
  referenceImageSchema,
  type ImageSettings,
} from "./image-settings.js";
export const efforts = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const kinds = [
  "model",
  "effort",
  "judge_model",
  "judge_effort",
  "variable",
  ...imageKinds,
] as const;
const axis = z.object({
  kind: z.enum(kinds),
  values: z
    .array(z.string().trim().min(1))
    .min(1)
    .refine((v) => new Set(v).size === v.length, "Values must be distinct"),
});
const budgetSchema = z.number().finite().positive();
const chatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "unfilled"]),
    content: z.string(),
  })
  .refine(
    (message) =>
      message.role === "unfilled"
        ? message.content === ""
        : message.content.trim().length > 0,
    "Enter a message, or leave an unfilled message empty.",
  );
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type FilledChatMessage = ChatMessage & {
  role: "system" | "user" | "assistant";
};
export function isChatFormat(format: GridInput["format"]): boolean {
  return format === "chat-template";
}
export function isMarkdownFormat(format: GridInput["format"]): boolean {
  return format === "markdown" || isChatFormat(format);
}
export function chatInputIssue(
  messages: ChatMessage[] = [],
): string | undefined {
  if (!messages.length) return "Add a message.";
  if (messages.some((m) => m.role !== "unfilled" && !m.content.trim()))
    return "Enter a message.";
  if (messages[0].role === "unfilled")
    return "Add a message before the first unfilled message.";
}
export function chatText(messages: ChatMessage[]): string {
  return messages
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n\n");
}
const gridFields = {
  prompt: z.string().trim().default(""),
  messages: z.array(chatMessageSchema).min(1).optional(),
  rows: axis,
  columns: axis,
  imageSettings: sharedImageSettingsSchema.optional(),
  inputReferences: z.array(referenceImageSchema).optional(),
  referenceGroups: z
    .record(z.string(), z.array(referenceImageSchema))
    .optional(),
  model: z.string().trim(),
  effort: z.enum(efforts),
  judge: z
    .object({
      criteria: z
        .array(z.object({
          text: z.string().trim().min(1, "Enter at least one yes/no criterion."),
          correctAnswer: z.boolean(),
        }))
        .min(1, "Enter at least one yes/no criterion."),
      model: z.string().trim(),
      effort: z.enum(efforts),
    })
    .optional(),
  parallelWorkers: z.number().int().min(1).optional(),
};
export const gridSchema = z
  .discriminatedUnion("format", [
    z.object({
      ...gridFields,
      format: z.enum(["svg", "markdown", "html", "chat-template"]),
      budgetUsd: budgetSchema,
    }),
    z.object({
      ...gridFields,
      format: z.literal("image"),
      // Keep numeric metadata for saved grids; image inference ignores it.
      budgetUsd: budgetSchema.catch(3),
    }),
  ])
  .transform((g) => {
    if (isChatFormat(g.format)) g.prompt = chatText(g.messages ?? []);
    else delete g.messages;
    return g;
  })
  .superRefine((g, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    if (isChatFormat(g.format)) {
      const message = chatInputIssue(g.messages);
      if (message) issue(message);
    }
    if (!g.prompt.trim()) issue("Enter a prompt.");
    if (![g.rows.kind, g.columns.kind].includes("model") && !g.model)
      issue("Select a model.");
    if (g.rows.kind === g.columns.kind && g.rows.kind !== "variable")
      issue("Choose different row and column dimensions");
    const dimensions = [g.rows.kind, g.columns.kind];
    if (
      !g.judge &&
      dimensions.some((kind) => kind === "judge_model" || kind === "judge_effort")
    )
      issue("Add a judge to use judge dimensions.");
    if (g.judge) {
      if (g.format === "html") issue("Websites do not support a judge yet.");
      if (!dimensions.includes("judge_model") && !g.judge.model)
        issue("Select a judge model.");
    }
    if (
      g.format === "image" &&
      [g.rows.kind, g.columns.kind].includes("effort")
    )
      issue("Images do not support thinking effort dimensions");
    for (const a of [g.rows, g.columns]) {
      if (
        (a.kind === "effort" || a.kind === "judge_effort") &&
        a.values.some((v) => !efforts.includes(v as (typeof efforts)[number]))
      )
        issue("Unknown thinking effort");
    }
    for (const axis of [g.rows, g.columns]) {
      if (imageKinds.some((kind) => kind === axis.kind) && g.format !== "image")
        issue("Image settings require Image output");
      if (
        imageKinds.some((kind) => kind === axis.kind) &&
        axis.kind !== "input_references" &&
        axis.values.some(
          (value) => !validImageSetting(axis.kind as ScalarImageKind, value),
        )
      )
        issue(
          axis.kind === "size"
            ? "Use a resolution or a size such as 1536x1024"
            : "Unknown image setting",
        );
      if (
        axis.kind === "input_references" &&
        axis.values.some((value) => !g.referenceGroups?.[value]?.length)
      )
        issue("Add images to every reference group");
    }
    const variableIssue = unusedVariableIssue(g);
    if (variableIssue) issue(variableIssue);
    if (g.prompt.includes("$ROW") && g.rows.kind !== "variable")
      issue("Choose prompt variables for rows to use $ROW");
    if (g.prompt.includes("$COLUMN") && g.columns.kind !== "variable")
      issue("Choose prompt variables for columns to use $COLUMN");
  })
  .transform((g) => {
    const dimensions = [g.rows.kind, g.columns.kind];
    const settings = normalizeImageSettings(g.imageSettings);
    for (const kind of dimensions) delete settings[kind as ScalarImageKind];
    if (g.format === "image" && Object.keys(settings).length)
      g.imageSettings = settings;
    else delete g.imageSettings;
    if (
      g.format !== "image" ||
      dimensions.includes("input_references") ||
      !g.inputReferences?.length
    )
      delete g.inputReferences;
    const groups = [g.rows, g.columns]
      .filter((axis) => axis.kind === "input_references")
      .flatMap((axis) => axis.values);
    if (groups.length)
      g.referenceGroups = Object.fromEntries(
        groups.map((name) => [name, g.referenceGroups![name]]),
      );
    else delete g.referenceGroups;
    return g;
  });
export type GridInput = z.infer<typeof gridSchema>;
export function unusedVariableIssue(
  input: Pick<GridInput, "prompt" | "rows" | "columns">,
): string | undefined {
  for (const [axis, token, label] of [
    [input.rows, "$ROW", "row"],
    [input.columns, "$COLUMN", "column"],
  ] as const)
    if (axis.kind === "variable" && !input.prompt.includes(token))
      return `Include ${token} in the prompt for ${label} variables.`;
}
export type Completion = {
  phase: "direct" | "image" | "judge";
  finishReason?: string;
  rawFinishReason?: string;
  reasoningTokens?: number;
};
export type InferenceProgress = {
  text: string;
  thinking: string;
  estimatedUsage?: Cell["usage"];
  currentCallCostUsd?: number;
};
export type JudgeResult = { verdict: boolean; explanation: string };
export type Cell = {
  id: string;
  row: number;
  column: number;
  model: string;
  effort: string;
  prompt: string;
  messages?: ChatMessage[];
  budgetUsd: number;
  imageSettings?: ImageSettings;
  status: "pending" | "running" | "complete" | "error";
  generationSourceId?: string;
  generationStatus?: Cell["status"];
  judge?: {
    model: string;
    effort: string;
    status: Cell["status"];
    attemptId?: string;
    results?: JudgeResult[];
    error?: string;
    errorCode?: string | number;
    retrying?: boolean;
  };
  error?: string;
  errorCode?: string | number;
  retrying?: boolean;
  attemptId?: string;
  mediaType?: string;
  draft?: string;
  thinking?: string;
  thinkingId?: string;
  provenance?: {
    signature: string;
    maxOutputTokens?: number;
    templateSteps?: TemplateStep[];
    files: string[];
  };
  estimatedUsage?: Cell["usage"];
  currentCallCostUsd?: number;
  preview?: { attempt: string; revision: number };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
};
export type TemplateStep = {
  maxOutputTokens?: number;
  usage?: Cell["usage"];
  costUsd?: number;
};
export type GridVisibility = "private" | "unlisted" | "public";
export type Identity = {
  provider: string;
  username: string;
  profileURL: string;
};
export type User = Identity & { id: string };
export type GridSummary = Pick<
  Grid,
  "id" | "title" | "status" | "published" | "visibility" | "slug"
> & {
  expanded_prompt_for_title: string;
  format: GridInput["format"];
  author: Identity | null;
};
export type Grid = {
  id: string;
  slug?: string;
  title?: string;
  owner: string;
  ownerUserId?: string;
  author?: Identity | null;
  input: GridInput;
  status: "running" | "paused" | "complete";
  published: boolean;
  visibility: GridVisibility;
  interruption?: "billing" | "restart" | "manual";
  cells: Cell[];
  createdAt: string;
};
export type StoredGrid = Grid & { expanded_prompt_for_title: string };
export function expandGrid(input: GridInput): Omit<Cell, "id">[] {
  return input.rows.values.flatMap((r, row) =>
    input.columns.values.map((c, column) => {
      const selections: Record<string, string> = {
        model: input.model,
        effort: input.effort,
      };
      const judge: Cell["judge"] = input.judge
        ? {
            model: input.judge.model,
            effort: input.judge.effort,
            status: "pending",
          }
        : undefined;
      const imageSettings: ImageSettings = { ...input.imageSettings };
      if (input.inputReferences?.length)
        imageSettings.input_references = input.inputReferences.map(
          (image) => image.id,
        );
      for (const [a, v] of [
        [input.rows, r],
        [input.columns, c],
      ] as const)
        if (a.kind === "model" || a.kind === "effort") selections[a.kind] = v;
        else if (a.kind === "judge_model" || a.kind === "judge_effort") {
          if (judge) {
            if (a.kind === "judge_model") judge.model = v;
            else judge.effort = v;
          }
        } else if (a.kind === "input_references")
          imageSettings.input_references =
            input.referenceGroups?.[v]?.map((image) => image.id) ?? [];
        else if (a.kind !== "variable") imageSettings[a.kind] = v;
      return {
        row,
        column,
        ...selections,
        model: selections.model,
        effort: selections.effort,
        prompt: input.prompt
          .replaceAll("$ROW", () => r)
          .replaceAll("$COLUMN", () => c),
        ...(input.messages
          ? {
              messages: input.messages?.map((message) => ({
                ...message,
                content: message.content
                  .replaceAll("$ROW", () => r)
                  .replaceAll("$COLUMN", () => c),
              })),
            }
          : {}),
        budgetUsd: input.budgetUsd,
        ...(input.format === "image"
          ? { imageSettings: normalizeImageSettings(imageSettings) }
          : {}),
        status: "pending" as const,
        ...(judge ? { judge } : {}),
      };
    }),
  );
}
