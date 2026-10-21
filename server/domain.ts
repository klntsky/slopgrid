import { z } from "zod";
import {
  imageKinds,
  validImageSetting,
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
  type VariableInterpolationOptions,
} from "./prompt-variables.js";
import {
  draftJudgeCriteriaSchema,
  judgeCriteriaIssue,
  criteriaSets,
  type Criterion,
} from "./judge-criteria.js";
import { parameterValue, axisParameters } from "./parameters.js";
import type { LegacyGridInput } from "./legacy-grid-input.js";
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
export type Effort = (typeof efforts)[number];
export const kinds = [
  "model",
  "effort",
  "judge_model",
  "judge_effort",
  "judge_criteria",
  "variable",
  ...imageKinds,
] as const;
const variableFieldSchema = z
  .object({
    text: z.string(),
    images: z.array(referenceImageSchema).optional(),
  })
  .strict();
export const parameterValueSchemas = {
  model: z.string(),
  effort: z.enum(efforts),
  size: z.string(),
  aspect_ratio: z.string(),
  quality: z.string(),
  background: z.string(),
  judge_model: z.string(),
  judge_effort: z.enum(efforts),
  judge_criteria: draftJudgeCriteriaSchema,
  variable: z.array(variableFieldSchema),
};
const parameterValuesSchema = z.object(parameterValueSchemas);
export type ParameterValues = z.infer<typeof parameterValuesSchema>;
const caseSchema = parameterValuesSchema
  .partial()
  .extend({
    id: z
      .string()
      .min(1)
      .default(() => globalThis.crypto.randomUUID()),
  })
  .strict();
export type CaseRecord = z.infer<typeof caseSchema>;
function source<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("common"), value }).strict(),
    z.object({ kind: z.literal("rows") }).strict(),
    z.object({ kind: z.literal("columns") }).strict(),
  ]);
}
const parameterSourcesSchema = z
  .object({
    model: source(parameterValueSchemas.model),
    effort: source(parameterValueSchemas.effort).optional(),
    size: source(parameterValueSchemas.size).optional(),
    aspect_ratio: source(parameterValueSchemas.aspect_ratio).optional(),
    quality: source(parameterValueSchemas.quality).optional(),
    background: source(parameterValueSchemas.background).optional(),
    judge_model: source(parameterValueSchemas.judge_model).optional(),
    judge_effort: source(parameterValueSchemas.judge_effort).optional(),
    judge_criteria: source(parameterValueSchemas.judge_criteria).optional(),
    variable: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("rows") }).strict(),
        z.object({ kind: z.literal("columns") }).strict(),
      ])
      .optional(),
  })
  .strict();
export type ParameterSources = z.infer<typeof parameterSourcesSchema>;
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
const draftGridFields = {
  inputVersion: z.literal(2),
  format: z.enum(["svg", "markdown", "html", "chat-template", "image"]),
  prompt: z.string().default(""),
  promptImages: z.array(referenceImageSchema).default([]),
  messages: z.array(draftChatMessageSchema).optional(),
  rows: z.array(caseSchema),
  columns: z.array(caseSchema),
  parameters: parameterSourcesSchema,
  judge: z.boolean().default(false),
  parallelWorkers: z.number().int().min(1).optional(),
};
export const gridDraftSchema = z
  .object({
    ...draftGridFields,
    budgetUsd: z.string(),
  })
  .strict()
  .refine(
    (input) => input.format !== "chat-template" || !input.promptImages.length,
    "Attach Chat images to individual user messages.",
  );
export type GridDraftInput = z.infer<typeof gridDraftSchema>;
const acceptedGridFields = {
  ...draftGridFields,
  messages: z.array(chatMessageSchema).min(1).optional(),
  rows: draftGridFields.rows.min(1),
  columns: draftGridFields.columns.min(1),
};
const gridInputSchema = z.discriminatedUnion("format", [
  z
    .object({
      ...acceptedGridFields,
      format: z.enum(["svg", "markdown", "html", "chat-template"]),
      budgetUsd: budgetSchema,
    })
    .strict(),
  z
    .object({
      ...acceptedGridFields,
      format: z.literal("image"),
      budgetUsd: budgetSchema.catch(3),
    })
    .strict(),
]);
export type GridInput = z.infer<typeof gridInputSchema>;
export type StoredGridInput = GridInput | LegacyGridInput;
export const gridSchema = gridInputSchema
  .transform((g) => {
    for (const kind of [
      "model",
      "judge_model",
      "size",
      "aspect_ratio",
      "quality",
      "background",
    ] as const) {
      const source = g.parameters[kind];
      if (source?.kind === "common") source.value = source.value.trim();
      for (const record of [...g.rows, ...g.columns]) {
        const value = record[kind];
        if (value !== undefined) record[kind] = value.trim();
      }
    }
    for (const criteria of criteriaSets(g))
      for (const criterion of criteria) criterion.text = criterion.text.trim();
    if (isChatFormat(g.format)) g.prompt = chatText(g.messages ?? []);
    else {
      g.prompt = g.prompt.trim();
      delete g.messages;
    }
    return g;
  })
  .superRefine((g, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    const applicable = new Set<keyof ParameterValues>(["model", "variable"]);
    if (g.format === "image")
      for (const kind of imageKinds) applicable.add(kind);
    else applicable.add("effort");
    if (g.judge) {
      if (g.format === "html") issue("Websites do not support a judge yet.");
      applicable.add("judge_model");
      applicable.add("judge_effort");
      applicable.add("judge_criteria");
    }
    for (const kind of kinds) {
      const source = g.parameters[kind];
      if (!applicable.has(kind)) {
        if (source) issue(`${kind} is not applicable to this grid.`);
        continue;
      }
      if (!source) {
        if (kind !== "variable") issue(`Choose a source for ${kind}.`);
        continue;
      }
      const values =
        source.kind === "common"
          ? [source.value]
          : g[source.kind].map((record) => record[kind]);
      for (const value of values) {
        if (value === undefined) {
          issue(`Add ${kind} to every ${source.kind} case.`);
          continue;
        }
        if (
          (kind === "model" || kind === "judge_model") &&
          (typeof value !== "string" || !value.trim())
        )
          issue(kind === "model" ? "Select a model." : "Select a judge model.");
        if (
          imageKinds.includes(kind as (typeof imageKinds)[number]) &&
          (typeof value !== "string" ||
            !validImageSetting(kind as ScalarImageKind, value))
        )
          issue(
            kind === "size"
              ? "Use a resolution or a size such as 1536x1024"
              : "Unknown image setting",
          );
      }
    }
    for (const side of ["rows", "columns"] as const) {
      const owned = new Set(axisParameters(g, side));
      const ids = new Set<string>();
      for (const record of g[side]) {
        if (ids.has(record.id))
          issue("Case IDs must be distinct within an axis.");
        ids.add(record.id);
        for (const key of Object.keys(record))
          if (key !== "id" && !owned.has(key as keyof ParameterValues))
            issue(`${key} is not owned by ${side}.`);
      }
    }
    if (isChatFormat(g.format)) {
      if (g.promptImages.length)
        issue("Attach Chat images to individual user messages.");
      const message = chatInputIssue(g.messages);
      if (message) issue(message);
    }
    const criterionIssue = judgeCriteriaIssue(g);
    if (criterionIssue) issue(criterionIssue);
    const variableIssue = promptVariableIssue(g);
    if (variableIssue) issue(variableIssue);
    // Only numbered fields vary message content; scalar case owners do not.
    const variableSide = g.parameters.variable?.kind;
    const contentRows =
      variableSide === "rows" ? g.rows.length : Math.min(1, g.rows.length);
    const contentColumns =
      variableSide === "columns"
        ? g.columns.length
        : Math.min(1, g.columns.length);
    if (!variableIssue && isChatFormat(g.format))
      for (let row = 0; row < contentRows; row++)
        for (let column = 0; column < contentColumns; column++) {
          const messages = g.messages?.map((message) => {
            const expanded = interpolateVariables(
              message.content,
              g,
              row,
              column,
            );
            const images = mergeVariableImages(message.images, expanded.images);
            return {
              ...message,
              content: expanded.text,
              ...(images ? { images } : {}),
            };
          });
          const message = chatInputIssue(messages);
          if (message) issue(message);
        }
    if (!variableIssue && !isChatFormat(g.format))
      for (let row = 0; row < contentRows; row++)
        for (let column = 0; column < contentColumns; column++) {
          const expanded = interpolateVariables(g.prompt, g, row, column);
          if (!expanded.text.trim()) {
            if (g.format === "image") issue("Enter a prompt.");
            else if (!g.promptImages.length && !expanded.images?.length)
              issue("Enter a prompt or attach an image for every case.");
          }
        }
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
    criteria?: Criterion[];
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
  input: StoredGridInput;
  status: "running" | "paused" | "complete";
  published: boolean;
  visibility: GridVisibility;
  interruption?: "billing" | "restart" | "manual";
  cells: Cell[];
  createdAt: string;
};
export type StoredGrid = Grid & { expanded_prompt_for_title: string };
export function expandGrid(
  input: GridInput,
  options: VariableInterpolationOptions = {},
): Omit<Cell, "id">[] {
  return input.rows.flatMap((_, row) =>
    input.columns.map((_, column) => {
      const model = parameterValue(input, "model", row, column) ?? "";
      const effort = parameterValue(input, "effort", row, column) ?? "default";
      const judge: Cell["judge"] = input.judge
        ? {
            model: parameterValue(input, "judge_model", row, column) ?? "",
            effort:
              parameterValue(input, "judge_effort", row, column) ?? "default",
            status: "pending",
          }
        : undefined;
      const imageSettings: ImageSettings = {};
      if (input.format === "image")
        for (const kind of imageKinds) {
          imageSettings[kind] = parameterValue(input, kind, row, column);
        }
      const messages = input.messages?.map((message) => {
        const content = interpolateVariables(
          message.content,
          input,
          row,
          column,
          options,
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
        : interpolateVariables(input.prompt, input, row, column, options);
      const attachments = messages
        ? undefined
        : mergeVariableImages(input.promptImages, expanded.images);
      if (input.format === "image" && attachments)
        imageSettings.input_references = attachments.map((image) => image.id);
      const images = input.format !== "image" ? attachments : undefined;
      return {
        row,
        column,
        model,
        effort,
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
