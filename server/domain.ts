import { z } from "zod";
import {
  imageKinds,
  validImageSetting,
  sharedImageSettingsSchema,
  draftImageSettingsSchema,
  normalizeImageSettings,
  type ScalarImageKind,
  referenceImageSchema,
  type ImageSettings,
  type ReferenceImage,
} from "./image-settings.js";
import {
  interpolateVariables,
  mergeVariableImages,
  promptVariableIssue,
} from "./prompt-variables.js";
import {
  judgeCriteriaSchema,
  draftJudgeCriteriaSchema,
  judgeCriteriaIssue,
  type Criterion,
} from "./judge-criteria.js";
export type { VariableField } from "./prompt-variables.js";
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
const variableFieldSchema = z.object({
  text: z.string(),
  images: z.array(referenceImageSchema).optional(),
});
const draftVariableAxis = z.object({
  kind: z.literal("variable"),
  values: z.array(z.array(variableFieldSchema)),
});
const variableAxis = draftVariableAxis.extend({
  values: draftVariableAxis.shape.values.element
    .min(1)
    .array()
    .min(1)
    .refine(
      (values) => values.every((fields) => fields.length === values[0].length),
      "Variable values must have the same number of fields.",
    ),
});
const draftScalarAxis = z.object({
  kind: z.enum(kinds.filter((kind) => kind !== "variable")),
  values: z.array(z.string()),
});
const scalarAxis = draftScalarAxis.extend({
  values: z
    .array(draftScalarAxis.shape.values.element.trim().min(1))
    .min(1)
    .refine((v) => new Set(v).size === v.length, "Values must be distinct"),
});
const axis = z.discriminatedUnion("kind", [variableAxis, scalarAxis]);
export type GridAxis = z.infer<typeof axis>;
const budgetSchema = z.number().finite().positive();
const draftChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "unfilled"]),
  content: z.string(),
  images: z.array(referenceImageSchema).optional(),
});
const chatMessageSchema = draftChatMessageSchema
  .refine(
    (message) => !message.images?.length || message.role === "user",
    "Images can only be attached to user messages.",
  )
  .refine(
    (message) =>
      message.role === "unfilled"
        ? message.content === ""
        : !!message.content.trim() ||
          (message.role === "user" && !!message.images?.length),
    "Enter a message, or leave an unfilled message empty.",
  )
  .transform((message) => {
    if (!message.images?.length) delete message.images;
    return message;
  });
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
  if (messages.some((m) => m.images?.length && m.role !== "user"))
    return "Images can only be attached to user messages.";
  if (
    messages.some(
      (m) =>
        m.role !== "unfilled" &&
        !m.content.trim() &&
        !(m.role === "user" && m.images?.length),
    )
  )
    return "Enter a message or attach an image.";
  if (messages[0].role === "unfilled")
    return "Add a message before the first unfilled message.";
}
export function chatText(messages: ChatMessage[]): string {
  return messages
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n\n");
}
const draftAxis = z.discriminatedUnion("kind", [
  draftVariableAxis,
  draftScalarAxis,
]);
const draftJudgeSchema = z.object({
  criteria: draftJudgeCriteriaSchema,
  model: z.string(),
  effort: z.enum(efforts),
});
const draftGridFields = {
  prompt: z.string().default(""),
  messages: z.array(draftChatMessageSchema).optional(),
  rows: draftAxis,
  columns: draftAxis,
  imageSettings: draftImageSettingsSchema.optional(),
  inputReferences: z.array(referenceImageSchema).optional(),
  referenceGroups: z
    .record(z.string(), z.array(referenceImageSchema))
    .optional(),
  model: z.string(),
  effort: z.enum(efforts),
  judge: draftJudgeSchema.optional(),
  parallelWorkers: z.number().int().min(1).optional(),
};
export const gridDraftSchema = z.object({
  ...draftGridFields,
  format: z.enum(["svg", "markdown", "html", "chat-template", "image"]),
  budgetUsd: z.string(),
});
export type GridDraftInput = z.infer<typeof gridDraftSchema>;
const gridFields = {
  ...draftGridFields,
  prompt: draftGridFields.prompt.unwrap().trim().default(""),
  messages: z.array(chatMessageSchema).min(1).optional(),
  rows: axis,
  columns: axis,
  imageSettings: sharedImageSettingsSchema.optional(),
  model: draftGridFields.model.trim(),
  judge: draftJudgeSchema
    .extend({
      criteria: judgeCriteriaSchema,
      model: draftJudgeSchema.shape.model.trim(),
    })
    .optional(),
};
const gridInputSchema = z.discriminatedUnion("format", [
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
]);
export type GridInput = z.infer<typeof gridInputSchema>;
export const gridSchema = gridInputSchema
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
      if (
        g.inputReferences?.length ||
        Object.keys(g.referenceGroups ?? {}).length
      )
        issue("Attach images to individual user messages.");
    }
    if (
      !g.prompt.trim() &&
      !(
        g.format !== "image" &&
        !isChatFormat(g.format) &&
        g.inputReferences?.length
      )
    )
      issue("Enter a prompt.");
    if (![g.rows.kind, g.columns.kind].includes("model") && !g.model)
      issue("Select a model.");
    if (g.rows.kind === g.columns.kind && g.rows.kind !== "variable")
      issue("Choose different row and column dimensions");
    const dimensions = [g.rows.kind, g.columns.kind];
    if (
      !g.judge &&
      dimensions.some(
        (kind) => kind === "judge_model" || kind === "judge_effort",
      )
    )
      issue("Add a judge to use judge dimensions.");
    if (g.judge) {
      if (g.format === "html") issue("Websites do not support a judge yet.");
      if (!dimensions.includes("judge_model") && !g.judge.model)
        issue("Select a judge model.");
      const message = judgeCriteriaIssue(g);
      if (message) issue(message);
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
        axis.kind !== "variable" &&
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
    const variableIssue = promptVariableIssue(g);
    if (variableIssue) issue(variableIssue);
  })
  .transform((g) => {
    const dimensions = [g.rows.kind, g.columns.kind];
    const settings = normalizeImageSettings(g.imageSettings);
    for (const kind of dimensions) delete settings[kind as ScalarImageKind];
    if (g.format === "image" && Object.keys(settings).length)
      g.imageSettings = settings;
    else delete g.imageSettings;
    if (
      isChatFormat(g.format) ||
      dimensions.includes("input_references") ||
      !g.inputReferences?.length
    )
      delete g.inputReferences;
    const groups = [g.rows, g.columns].flatMap((axis) =>
      axis.kind === "input_references" ? axis.values : [],
    );
    if (groups.length)
      g.referenceGroups = Object.fromEntries(
        groups.map((name) => [name, g.referenceGroups![name]]),
      );
    else delete g.referenceGroups;
    return g;
  })
  .brand<"ValidatedGridInput">();
export type ValidatedGridInput = z.infer<typeof gridSchema>;
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
  images?: ReferenceImage[];
  budgetUsd: number;
  imageSettings?: ImageSettings;
  status: "pending" | "running" | "complete" | "error";
  generationId?: string;
  judgmentId?: string;
  artifactId?: string;
  thinkingSourceId?: string;
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
export type WorkflowState = {
  status: Cell["status"];
  attemptId?: string;
  error?: string;
  errorCode?: string | number;
  retrying?: boolean;
};
export type Task<Input, Output> = WorkflowState & {
  id: string;
  input: Input;
  output?: Output;
};
export type GenerationParameters = Pick<
  Cell,
  | "model"
  | "effort"
  | "prompt"
  | "messages"
  | "images"
  | "budgetUsd"
  | "imageSettings"
>;
export type GenerationInput = GenerationParameters & {
  format: GridInput["format"];
};
export type GenerationOutput = {
  artifactId: string;
  mediaType?: string;
  provenance: NonNullable<Cell["provenance"]>;
  usage?: Cell["usage"];
  thinkingId?: string;
  thinkingSourceId?: string;
};
export type GenerationTask = Task<GenerationInput, GenerationOutput> & {
  kind: "generation";
  progress?: Pick<
    Cell,
    | "draft"
    | "thinking"
    | "thinkingId"
    | "thinkingSourceId"
    | "estimatedUsage"
    | "currentCallCostUsd"
    | "usage"
    | "preview"
  >;
};
export type JudgmentInput = {
  model: string;
  effort: string;
  criteria: Criterion[];
  images?: ReferenceImage[];
};
export type JudgmentTask = Task<JudgmentInput, { results: JudgeResult[] }> & {
  kind: "judge";
  generationId: string;
};
export type WorkflowTask = GenerationTask | JudgmentTask;
export function hasCompletedOutput(cell: Pick<Cell, "artifactId">): boolean {
  return !!cell.artifactId;
}
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
  return input.rows.values.flatMap((_, row) =>
    input.columns.values.map((_, column) => {
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
      if (input.format === "image" && input.inputReferences?.length)
        imageSettings.input_references = input.inputReferences.map(
          (image) => image.id,
        );
      for (const [a, index] of [
        [input.rows, row],
        [input.columns, column],
      ] as const) {
        if (a.kind === "variable") continue;
        const v = a.values[index];
        if (a.kind === "model" || a.kind === "effort") selections[a.kind] = v;
        else if (a.kind === "judge_model" || a.kind === "judge_effort") {
          if (judge) {
            if (a.kind === "judge_model") judge.model = v;
            else judge.effort = v;
          }
        } else if (a.kind === "input_references")
          imageSettings.input_references =
            input.referenceGroups?.[v]?.map((image) => image.id) ?? [];
        else imageSettings[a.kind] = v;
      }
      const messages = input.messages?.map((message) => {
        const content = interpolateVariables(
          message.content,
          input,
          row,
          column,
        );
        const images = mergeVariableImages(message.images, content.images);
        return {
          ...message,
          content: content.text,
          ...(images ? { images } : {}),
        };
      });
      const expanded = messages
        ? { text: chatText(messages), images: undefined }
        : interpolateVariables(input.prompt, input, row, column);
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
            ? mergeVariableImages(input.inputReferences, expanded.images)
            : expanded.images
          : undefined;
      return {
        row,
        column,
        ...selections,
        model: selections.model,
        effort: selections.effort,
        prompt: expanded.text,
        ...(messages ? { messages } : {}),
        ...(images ? { images } : {}),
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
