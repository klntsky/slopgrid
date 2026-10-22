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
  promptVariableIssues,
  referencedVariableFields,
  type VariableInterpolationOptions,
} from "./prompt-variables.js";
import {
  draftJudgeCriteriaSchema,
  judgeCriteriaIssues,
  criteriaSets,
  criteriaForCell,
  type Criterion,
  judgeCriteriaSchema,
  resolveCriteriaForCell,
} from "./judge-criteria.js";
import {
  parameterValue,
  axisParameters,
  parameterLayoutIssues,
  parameterValuePath,
  type ValidationIssue,
  type ParameterConfiguration,
} from "./parameters.js";
import type { LegacyGridInput } from "./legacy-grid-input.js";
import type { Version2GridInput } from "./legacy-grid-input.js";
import {
  generatorInputEntries,
  generatorInputForCell,
} from "./generator-input.js";
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
const draftChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "unfilled"]),
    content: z.string(),
    images: z.array(referenceImageSchema).optional(),
  })
  .strict();
export type ChatMessage = z.infer<typeof draftChatMessageSchema>;
export const kinds = [
  "model",
  "input",
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
  input: z.array(draftChatMessageSchema),
  model: z.string(),
  effort: z.enum(efforts),
  size: z.string(),
  aspect_ratio: z.string(),
  quality: z.string(),
  background: z.string(),
  judge_model: z.string(),
  judge_effort: z.enum(efforts),
  judge_criteria: draftJudgeCriteriaSchema,
  variable: z.array(variableFieldSchema.nullable()),
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
    input: source(parameterValueSchemas.input),
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
export type FilledChatMessage = ChatMessage & {
  role: "system" | "user" | "assistant";
};
export function isChatFormat(format: GridInput["format"]): boolean {
  return format === "chat-template";
}
export function isMarkdownFormat(format: GridInput["format"]): boolean {
  return format === "markdown" || isChatFormat(format);
}
export function chatInputIssues(
  messages: ChatMessage[] = [],
): ValidationIssue[] {
  if (!messages.length) return [{ message: "Add a message.", path: [] }];
  const issues: ValidationIssue[] = [];
  messages.forEach((message, index) => {
    if (message.images?.length && message.role !== "user")
      issues.push({
        message: "Images can only be attached to user messages.",
        path: [index, "images"],
      });
  });
  messages.forEach((message, index) => {
    if (
      message.role !== "unfilled" &&
      !message.content.trim() &&
      !(message.role === "user" && message.images?.length)
    )
      issues.push({
        message: "Enter a message or attach an image.",
        path: [index, "content"],
      });
  });
  messages.forEach((message, index) => {
    if (message.role === "unfilled" && message.content !== "")
      issues.push({
        message: "Leave unfilled messages empty.",
        path: [index, "content"],
      });
  });
  if (messages[0].role === "unfilled")
    issues.push({
      message: "Add a message before the first unfilled message.",
      path: [0, "role"],
    });
  return issues;
}

export function chatInputIssue(
  messages: ChatMessage[] = [],
): string | undefined {
  return chatInputIssues(messages)[0]?.message;
}
export function chatText(messages: ChatMessage[]): string {
  return messages
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n\n");
}
const draftGridFields = {
  inputVersion: z.literal(3),
  format: z.enum(["svg", "markdown", "html", "chat-template", "image"]),
  caseAxis: z.enum(["rows", "columns"]).optional(),
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
  .strict();
export type GridDraftInput = z.infer<typeof gridDraftSchema>;
const acceptedGridFields = {
  ...draftGridFields,
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
export type StoredGridInput = GridInput | Version2GridInput | LegacyGridInput;
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
    return g;
  })
  .superRefine((g, c) => {
    const reported = new Set<string>();
    const issue = (message: string, path: (string | number)[]) => {
      const key = JSON.stringify([path, message]);
      if (reported.has(key)) return;
      reported.add(key);
      c.addIssue({ code: "custom", message, path });
    };
    const applicable = new Set<keyof ParameterValues>([
      "input",
      "model",
      "variable",
    ]);
    if (g.format === "image")
      for (const kind of imageKinds) applicable.add(kind);
    else applicable.add("effort");
    if (g.judge) {
      if (g.format === "html")
        issue("Websites do not support a judge yet.", ["judge"]);
      applicable.add("judge_model");
      applicable.add("judge_effort");
      applicable.add("judge_criteria");
    }
    for (const kind of kinds) {
      const source = g.parameters[kind];
      if (!applicable.has(kind)) {
        if (source)
          issue(`${kind} is not applicable to this grid.`, [
            "parameters",
            kind,
          ]);
        continue;
      }
      if (!source) {
        if (kind !== "variable")
          issue(`Choose a source for ${kind}.`, ["parameters", kind]);
        continue;
      }
      const values =
        source.kind === "common"
          ? [source.value]
          : g[source.kind].map((record) => record[kind]);
      for (const [index, value] of values.entries()) {
        const path = parameterValuePath(g, kind, index, index);
        if (value === undefined) {
          issue(`Add ${kind} to every ${source.kind} case.`, path);
          continue;
        }
        if (
          (kind === "model" || kind === "judge_model") &&
          (typeof value !== "string" || !value.trim())
        )
          issue(
            kind === "model" ? "Select a model." : "Select a judge model.",
            path,
          );
        if (
          imageKinds.includes(kind as (typeof imageKinds)[number]) &&
          (typeof value !== "string" ||
            !validImageSetting(kind as ScalarImageKind, value))
        )
          issue(
            kind === "size"
              ? "Use a resolution or a size such as 1536x1024"
              : "Unknown image setting",
            path,
          );
      }
    }
    for (const item of parameterLayoutIssues(g)) issue(item.message, item.path);
    for (const side of ["rows", "columns"] as const) {
      const owned = new Set(axisParameters(g, side));
      const ids = new Set<string>();
      for (const [index, record] of g[side].entries()) {
        if (ids.has(record.id))
          issue("Case IDs must be distinct within an axis.", [
            side,
            index,
            "id",
          ]);
        ids.add(record.id);
        for (const key of Object.keys(record))
          if (key !== "id" && !owned.has(key as keyof ParameterValues))
            issue(`${key} is not owned by ${side}.`, [side, index, key]);
      }
    }
    for (const { caseIndex, messages } of generatorInputEntries(g)) {
      const path = parameterValuePath(
        g,
        "input",
        caseIndex ?? 0,
        caseIndex ?? 0,
      );
      if (
        !isChatFormat(g.format) &&
        (messages.length !== 1 || messages[0]?.role !== "user")
      )
        issue("Prompt formats require exactly one user message.", path);
      // Expanded content is checked below, since a consumed variable may supply images.
      for (const item of chatInputIssues(messages))
        if (
          item.path.at(-1) !== "content" ||
          messages[item.path[0] as number]?.role === "unfilled"
        )
          issue(item.message, [...path, ...item.path]);
    }
    for (const item of judgeCriteriaIssues(g)) issue(item.message, item.path);
    for (const item of promptVariableIssues(g)) issue(item.message, item.path);
    const expandedIssue = (
      item: ValidationIssue,
      path: (string | number)[],
      template: string,
      row: number,
      column: number,
    ) => {
      issue(item.message, [...path, ...item.path]);
      if (item.path.at(-1) === "content" || item.path.at(-1) === "text")
        for (const reference of referencedVariableFields(
          template,
          g,
          row,
          column,
        ))
          issue(item.message, [...reference.path, "text"]);
    };
    const contentCases = g.caseAxis ? g[g.caseAxis].length : 1;
    for (let index = 0; index < contentCases; index++) {
      const row = g.caseAxis === "rows" ? index : 0;
      const column = g.caseAxis === "columns" ? index : 0;
      const rawMessages = generatorInputForCell(g, row, column);
      const inputPath = parameterValuePath(g, "input", row, column);
      const messages = expandGeneratorInput(g, row, column, {
        allowUnresolvedVariables: true,
      });
      for (const item of chatInputIssues(messages)) {
        // Variable-image role violations retain their more specific template error.
        if (item.path.at(-1) === "images") continue;
        expandedIssue(
          item,
          inputPath,
          rawMessages[item.path[0] as number]?.content ?? "",
          row,
          column,
        );
      }
      if (g.format === "image" && !messages[0]?.content.trim())
        expandedIssue(
          {
            message: "Enter a prompt.",
            path: messages.length ? [0, "content"] : [],
          },
          inputPath,
          rawMessages[0]?.content ?? "",
          row,
          column,
        );
      if (g.judge) {
        const resolved = resolveCriteriaForCell(g, row, column, {
          allowUnresolvedVariables: true,
        });
        const criteria = judgeCriteriaSchema.safeParse(resolved.criteria);
        if (!criteria.success) {
          const rawCriteria = criteriaForCell(g, row, column);
          const criteriaPath = parameterValuePath(
            g,
            "judge_criteria",
            row,
            column,
          );
          for (const item of criteria.error.issues)
            expandedIssue(
              { message: item.message, path: item.path as (string | number)[] },
              criteriaPath,
              rawCriteria[item.path[0] as number]?.text ?? "",
              row,
              column,
            );
        }
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
export function expandGeneratorInput(
  input: ParameterConfiguration,
  row: number,
  column: number,
  options: VariableInterpolationOptions = {},
): ChatMessage[] {
  return generatorInputForCell(input, row, column).map((message) => {
    const expanded = interpolateVariables(
      message.content,
      input,
      row,
      column,
      options,
    );
    const images = mergeVariableImages(
      message.images,
      message.role === "user" ? expanded.images : undefined,
    );
    return {
      ...message,
      content: expanded.text,
      ...(images ? { images } : {}),
    };
  });
}

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
      const messages = expandGeneratorInput(input, row, column, options);
      const prompt = isChatFormat(input.format)
        ? chatText(messages)
        : (messages[0]?.content ?? "");
      const attachments = messages[0]?.images;
      if (input.format === "image" && attachments)
        imageSettings.input_references = attachments.map((image) => image.id);
      const images = input.format !== "image" ? attachments : undefined;
      return {
        row,
        column,
        model,
        effort,
        prompt,
        messages,
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
