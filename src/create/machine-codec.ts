import { z } from "zod";
import { efforts, parameterValueSchemas } from "../../server/domain.js";
import {
  referenceImageSchema,
  imageEndpointSchema,
} from "../../server/image-settings.js";
import type {
  CreateContext,
  CreateEvent,
  CreateInitial,
  CreateOutcome,
  CreateCommand,
  CreateView,
  Draft,
} from "./machine-contract.js";

type DataObject = Record<string, unknown>;

function dataKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  const result: string[] = [];
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string")
      throw new TypeError("Creation data cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError("Creation data requires enumerable data properties.");
    result.push(key);
  }
  return result;
}

function visitData(
  value: unknown,
  ancestors: Set<object>,
  clone: boolean,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Creation numbers must be finite.");
    return value === 0 ? 0 : value;
  }
  if (typeof value !== "object")
    throw new TypeError("Creation data must be plain JSON data.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (array ? Array.prototype : Object.prototype) &&
    !(prototype === null && !array)
  )
    throw new TypeError("Creation data must use plain objects and arrays.");
  if (ancestors.has(value))
    throw new TypeError("Creation data cannot contain cycles.");
  const keys = dataKeys(value);
  if (
    array &&
    (keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)))
  )
    throw new TypeError(
      "Creation arrays cannot contain holes or extra properties.",
    );
  ancestors.add(value);
  const result: unknown[] | DataObject | undefined = clone
    ? array
      ? []
      : {}
    : undefined;
  for (const key of keys) {
    const child = Object.getOwnPropertyDescriptor(value, key)!.value;
    if (!array && child === undefined) continue;
    const copied = visitData(child, ancestors, clone);
    if (result)
      Object.defineProperty(result, key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  ancestors.delete(value);
  return clone ? result : value;
}

export function copyCreationData<T>(value: T): T {
  return visitData(value, new Set(), true) as T;
}

/** Compares canonical data already validated by a codec or copyCreationData. */
export function equalCreationData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (
      a === null ||
      b === null ||
      typeof a !== "object" ||
      typeof b !== "object"
    )
      return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aKeys = Object.keys(a).filter(
      (key) => (a as DataObject)[key] !== undefined,
    );
    const bKeys = Object.keys(b).filter(
      (key) => (b as DataObject)[key] !== undefined,
    );
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equal((a as DataObject)[key], (b as DataObject)[key]),
    );
  }
  return equal(left, right);
}

function normalizeData(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const object = value as DataObject;
    if (object[key] === undefined) delete object[key];
    else if (object[key] === 0) object[key] = 0;
    else normalizeData(object[key]);
  }
}

function codec<T>(schema: z.ZodType<T>) {
  function parse(value: unknown): T {
    visitData(value, new Set(), false);
    const parsed = schema.parse(value);
    normalizeData(parsed);
    return parsed;
  }
  return {
    parse,
    encode(value: T): string {
      return JSON.stringify(parse(value));
    },
    decode(json: string): T {
      return parse(JSON.parse(json));
    },
  };
}

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const format = z.enum(["svg", "markdown", "html", "chat-template", "image"]);
const side = z.enum(["rows", "columns"]);
const parameter = z.enum([
  "input",
  "model",
  "effort",
  "size",
  "aspect_ratio",
  "quality",
  "background",
  "judge_model",
  "judge_effort",
  "judge_criteria",
  "judge_system",
  "variable",
]);
const commonParameter = parameter.exclude(["variable"]);
const scalarParameter = commonParameter.exclude([
  "input",
  "judge_criteria",
  "judge_system",
]);
const reference = referenceImageSchema
  .strict()
  .refine(
    (image) =>
      (image.width === undefined || Number.isSafeInteger(image.width)) &&
      (image.height === undefined || Number.isSafeInteger(image.height)),
    "Reference dimensions must be safe integers.",
  );
const parameterSchemas = {
  ...parameterValueSchemas,
  input: z.array(
    parameterValueSchemas.input.element.extend({
      images: z.array(reference).optional(),
    }),
  ),
  variable: z.array(
    parameterValueSchemas.variable.element
      .unwrap()
      .extend({ images: z.array(reference).optional() })
      .nullable(),
  ),
};
const caseRecord = z
  .object({
    ...parameterSchemas,
  })
  .partial()
  .extend({ id: z.string().min(1), name: z.string().optional() })
  .strict();

function source<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("common"), value }).strict(),
    z.object({ kind: z.literal("rows") }).strict(),
    z.object({ kind: z.literal("columns") }).strict(),
  ]);
}

const gridFields = {
  inputVersion: z.literal(3),
  format,
  caseAxes: z
    .array(side)
    .refine(
      (axes) => new Set(axes).size === axes.length,
      "Case axes must be distinct.",
    ),
  rows: z.array(caseRecord),
  columns: z.array(caseRecord),
  variableNames: z
    .object({
      rows: z.array(z.string().nullable()).optional(),
      columns: z.array(z.string().nullable()).optional(),
    })
    .strict()
    .optional(),
  parameters: z
    .object({
      input: source(parameterSchemas.input),
      model: source(parameterValueSchemas.model),
      effort: source(parameterValueSchemas.effort).optional(),
      size: source(parameterValueSchemas.size).optional(),
      aspect_ratio: source(parameterValueSchemas.aspect_ratio).optional(),
      quality: source(parameterValueSchemas.quality).optional(),
      background: source(parameterValueSchemas.background).optional(),
      judge_model: source(parameterValueSchemas.judge_model).optional(),
      judge_effort: source(parameterValueSchemas.judge_effort).optional(),
      judge_criteria: source(parameterValueSchemas.judge_criteria).optional(),
      judge_system: source(parameterValueSchemas.judge_system).optional(),
    })
    .strict(),
  judge: z.boolean(),
  parallelWorkers: requestId.optional(),
};
const draftInput = z.object({ ...gridFields, budgetUsd: z.string() }).strict();
const gridInput = z
  .object({ ...gridFields, budgetUsd: finite.positive() })
  .strict();
const draft = z
  .object({
    formatSelected: z.boolean(),
    input: draftInput,
    sourceGridId: z.string().optional(),
    reuseArtifacts: z.boolean().optional(),
  })
  .strict();
const provider = z
  .object({
    connected: z.boolean(),
    capacity: z
      .object({
        format,
        status: z.enum(["pending", "ready", "error"]),
        parallelWorkers: requestId.nullable(),
      })
      .strict(),
  })
  .strict();

export const creationDraftCodec = codec<Draft>(draft);
export const creationInitialCodec = codec<CreateInitial>(
  z.object({ draft, caseIdPrefix: z.string() }).strict(),
);
export const creationContextCodec = codec<CreateContext>(
  z
    .object({
      catalog: z.array(
        z.object({
          id: z.string(),
          aliasTarget: z.string().optional(),
          canonicalSlug: z.string().optional(),
          name: z.string(),
          image: z.boolean(),
          imageInput: z.boolean(),
          text: z.boolean(),
          reasoning: z.boolean(),
          reasoningMandatory: z.boolean(),
          structuredOutputs: z.boolean().optional(),
          reasoningEfforts: z.array(z.enum(efforts)).optional(),
          imageEndpoints: z.array(imageEndpointSchema).optional(),
        }),
      ),
      provider,
    })
    .strict(),
);

const messageEdit = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), index, content: z.string() }).strict(),
  z.object({ type: z.literal("insert"), index }).strict(),
  z.object({ type: z.literal("remove"), index }).strict(),
  z.object({ type: z.literal("move"), index, to: index }).strict(),
  z
    .object({
      type: z.literal("cycle-role"),
      index,
      rememberedContent: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("append-images"),
      index,
      images: z.array(reference),
    })
    .strict(),
  z
    .object({ type: z.literal("remove-image"), index, imageIndex: index })
    .strict(),
  z.object({ type: z.literal("prompt-content"), content: z.string() }).strict(),
  z
    .object({
      type: z.literal("prompt-append-images"),
      images: z.array(reference),
    })
    .strict(),
  z
    .object({ type: z.literal("prompt-remove-image"), imageIndex: index })
    .strict(),
]);

const inputEvent = z
  .union([
    z
      .object({
        type: z.literal("common"),
        parameter: commonParameter,
        value: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("case-value"),
        parameter,
        side,
        index,
        value: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("case-values"),
        parameter: scalarParameter,
        side,
        values: z.array(z.unknown()),
      })
      .strict(),
  ])
  .transform(
    (
      event,
      ctx,
    ): Extract<
      CreateEvent,
      { type: "common" | "case-value" | "case-values" }
    > => {
      const schema = parameterSchemas[event.parameter];
      const result =
        event.type === "case-values"
          ? z.array(schema).safeParse(event.values)
          : schema.safeParse(event.value);
      if (!result.success) {
        for (const issue of result.error.issues)
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: [
              event.type === "case-values" ? "values" : "value",
              ...issue.path,
            ],
          });
        return z.NEVER;
      }
      const parsed =
        event.type === "case-values"
          ? { ...event, values: result.data }
          : { ...event, value: result.data };
      return parsed as Extract<
        CreateEvent,
        { type: "common" | "case-value" | "case-values" }
      >;
    },
  );

export const creationEventCodec = codec<CreateEvent>(
  z.union([
    inputEvent,
    z
      .object({
        type: z.literal("edit-input"),
        source: z.enum(["common", "rows", "columns"]),
        caseIndex: index.optional(),
        edit: messageEdit,
      })
      .strict(),
    z
      .object({ type: z.literal("to-axis"), parameter: commonParameter, side })
      .strict(),
    z
      .object({ type: z.literal("to-common"), parameter: commonParameter })
      .strict(),
    z.object({ type: z.literal("dimension"), parameter, side }).strict(),
    z.object({ type: z.literal("single"), side }).strict(),
    z.object({ type: z.literal("add-case"), side, value: caseRecord }).strict(),
    z.object({ type: z.literal("remove-case"), side, index }).strict(),
    z.object({ type: z.literal("move-case"), side, index, to: index }).strict(),
    z.object({ type: z.literal("add-variable"), side }).strict(),
    z.object({ type: z.literal("remove-variable"), side, index }).strict(),
    z
      .object({
        type: z.literal("rename-variable"),
        side,
        index,
        name: z.string(),
      })
      .strict(),
    z
      .object({ type: z.literal("rename-case"), side, index, name: z.string() })
      .strict(),
    z.object({ type: z.literal("swap") }).strict(),
    z.object({ type: z.literal("judge"), enabled: z.boolean() }).strict(),
    z.object({ type: z.literal("format-selected"), format }).strict(),
    z.object({ type: z.literal("format-cleared") }).strict(),
    z.object({ type: z.literal("budget-changed"), value: z.string() }).strict(),
    z
      .object({
        type: z.literal("reuse-artifacts-changed"),
        value: z.boolean(),
      })
      .strict(),
    z.object({ type: z.literal("provider-observed"), provider }).strict(),
    z
      .object({
        type: z.literal("reference-uploaded"),
        id: requestId,
        localId: z.string(),
        image: reference,
      })
      .strict(),
    z
      .object({ type: z.literal("upload-status-changed"), busy: z.boolean() })
      .strict(),
    z
      .object({
        type: z.literal("confirmation-resolved"),
        id: requestId,
        accepted: z.boolean(),
      })
      .strict(),
    z
      .object({
        type: z.literal("generate-requested"),
        continueWithLowBalance: z.boolean(),
      })
      .strict(),
    z
      .object({ type: z.literal("references-prepared"), id: requestId })
      .strict(),
    z
      .object({
        type: z.literal("submission-succeeded"),
        id: requestId,
        gridId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("submission-failed"),
        id: requestId,
        message: z.string(),
        balanceUsd: finite.nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("completion-failed"),
        id: requestId,
        message: z.string(),
      })
      .strict(),
    z.object({ type: z.literal("low-balance-dismissed") }).strict(),
  ]),
);

const status = z.enum(["pending", "running", "complete", "error"]);
const criterion = z
  .object({ text: z.string(), correctAnswer: z.boolean() })
  .strict();
const usage = z
  .object({
    inputTokens: index.optional(),
    outputTokens: index.optional(),
    costUsd: finite.optional(),
  })
  .strict();
const templateStep = z
  .object({
    maxOutputTokens: index.optional(),
    usage: usage.optional(),
    costUsd: finite.optional(),
  })
  .strict();
const errorCode = z.union([z.string(), finite]);
const compatibilityCell = z
  .object({
    row: index,
    column: index,
    model: z.string(),
    effort: z.string(),
    prompt: z.string(),
    messages: parameterSchemas.input.optional(),
    budgetUsd: finite.nullable(),
    imageSettings: z
      .object({
        size: z.string().optional(),
        aspect_ratio: z.string().optional(),
        quality: z.string().optional(),
        background: z.string().optional(),
        input_references: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    status,
    generationId: z.string().optional(),
    judgmentId: z.string().optional(),
    artifactId: z.string().optional(),
    thinkingSourceId: z.string().optional(),
    judge: z
      .object({
        model: z.string(),
        effort: z.string(),
        criteria: z.array(criterion).optional(),
        status,
        attemptId: z.string().optional(),
        results: z
          .array(
            z
              .object({ verdict: z.boolean(), explanation: z.string() })
              .strict(),
          )
          .optional(),
        error: z.string().optional(),
        errorCode: errorCode.optional(),
        retrying: z.boolean().optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
    errorCode: errorCode.optional(),
    retrying: z.boolean().optional(),
    attemptId: z.string().optional(),
    mediaType: z.string().optional(),
    draft: z.string().optional(),
    thinking: z.string().optional(),
    thinkingId: z.string().optional(),
    provenance: z
      .object({
        signature: z.string(),
        maxOutputTokens: index.optional(),
        templateSteps: z.array(templateStep).optional(),
        files: z.array(z.string()),
      })
      .strict()
      .optional(),
    estimatedUsage: usage.optional(),
    currentCallCostUsd: finite.optional(),
    preview: z
      .object({ attempt: z.string(), revision: index })
      .strict()
      .optional(),
    usage: usage.optional(),
  })
  .strict();
const compatibilityOrigin = z
  .object({
    parameter,
    source: z.enum(["common", "rows", "columns"]),
    caseIndex: index.optional(),
    fieldIndex: index.optional(),
    messageIndex: index.optional(),
  })
  .strict();

export const creationViewCodec = codec<CreateView>(
  z
    .object({
      draft,
      attempted: z.boolean(),
      pendingUploads: index,
      error: z.string(),
      lowBalance: finite.nullable(),
      submissionPhase: z.enum(["idle", "preparing", "submitting", "completed"]),
      validationIssues: z.array(
        z
          .object({
            message: z.string(),
            path: z.array(z.union([z.string(), index])),
          })
          .strict(),
      ),
      compatibilityIssues: z.array(
        z
          .object({
            row: index,
            column: index,
            parameters: z.array(parameter),
            origins: z.array(compatibilityOrigin),
            support: z.enum(["unsupported", "unknown"]),
            blocking: z.boolean(),
            reason: z.string(),
          })
          .strict(),
      ),
      compatibilityCells: z.array(compatibilityCell),
      eligibility: z
        .object({
          canAttempt: z.boolean(),
          canSubmit: z.boolean(),
          reasons: z.array(z.string()),
          parallelWorkers: requestId.nullable(),
        })
        .strict(),
    })
    .strict()
    .refine(
      (value) => !value.eligibility.canSubmit || value.eligibility.canAttempt,
      "Submission requires attempt eligibility.",
    ),
);

const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("persist-draft"), draft }).strict(),
  z
    .object({ type: z.literal("confirm"), id: requestId, message: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("prepare-references"),
      id: requestId,
      input: gridInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("submit-grid"),
      id: requestId,
      input: gridInput,
      sourceGridId: z.string().optional(),
      reuseArtifacts: z.boolean(),
      continueWithLowBalance: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("creation-completed"),
      id: requestId,
      gridId: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("navigate-home") }).strict(),
  z
    .object({ type: z.literal("remove-reference-file"), localId: z.string() })
    .strict(),
]);

export const creationOutputCodec = codec<{
  outcome: CreateOutcome;
  commands: CreateCommand[];
}>(
  z
    .object({
      outcome: z
        .object({ stateChanged: z.boolean(), draftChanged: z.boolean() })
        .strict(),
      commands: z.array(command),
    })
    .strict()
    .refine(
      (value) => !value.outcome.draftChanged || value.outcome.stateChanged,
      "A draft change must also change state.",
    ),
);
