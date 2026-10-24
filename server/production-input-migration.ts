import { z } from "zod";
import {
  gridDraftSchema,
  type ChatMessage,
  type GridInput,
  type ParameterValues,
} from "./domain.js";
import type { AxisSide, CommonParameterId } from "./parameters.js";

// Frozen production v14 shapes: migration must not depend on today's model
// catalog, capability admission, or provider-specific setting choices.
const productionEffort = z.enum([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const productionReference = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  mediaType: z.string().optional(),
});
const productionAxis = z
  .object({
    kind: z.enum([
      "model",
      "effort",
      "judge_model",
      "judge_effort",
      "variable",
      "size",
      "aspect_ratio",
      "quality",
      "background",
      "input_references",
    ]),
    values: z.array(z.string()).min(1),
  })
  .strict();
const productionInputSchema = z
  .object({
    format: z.enum(["svg", "markdown", "html", "chat-template", "image"]),
    prompt: z.string(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant", "unfilled"]),
            content: z.string(),
          })
          .strict(),
      )
      .optional(),
    rows: productionAxis,
    columns: productionAxis,
    model: z.string(),
    effort: productionEffort,
    budgetUsd: z.number().finite().positive(),
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
    inputReferences: z.array(productionReference).optional(),
    referenceGroups: z
      .record(z.string(), z.array(productionReference))
      .optional(),
    judge: z
      .object({
        model: z.string(),
        effort: productionEffort,
        criteria: z.array(
          z.object({ text: z.string(), correctAnswer: z.boolean() }).strict(),
        ),
      })
      .strict()
      .optional(),
    parallelWorkers: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.rows.kind !== input.columns.kind || input.rows.kind === "variable",
    "Production axes must own distinct parameters.",
  );
export type ProductionInput = z.infer<typeof productionInputSchema>;

const sides = ["rows", "columns"] as const;
const numberedToken = /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu;

export function migrateProductionInput(value: unknown): GridInput {
  const old = productionInputSchema.parse(value);
  const result: GridInput = {
    inputVersion: 3,
    format: old.format,
    budgetUsd: old.budgetUsd,
    judge: !!old.judge,
    caseAxes: [],
    rows: old.rows.values.map((_, index) => ({ id: `row-${index + 1}` })),
    columns: old.columns.values.map((_, index) => ({
      id: `column-${index + 1}`,
    })),
    parameters: {
      input: { kind: "common", value: [] },
      model: { kind: "common", value: old.model },
      ...(old.format === "image"
        ? {}
        : { effort: { kind: "common" as const, value: old.effort } }),
    },
    ...(old.parallelWorkers === undefined
      ? {}
      : { parallelWorkers: old.parallelWorkers }),
  };
  const cases = (side: AxisSide) => {
    if (!result.caseAxes.includes(side)) result.caseAxes.push(side);
  };
  const common = <K extends CommonParameterId>(
    kind: K,
    parameter: ParameterValues[K],
  ) => {
    Object.assign(result.parameters, {
      [kind]: { kind: "common", value: parameter },
    });
  };
  const fields = (side: AxisSide, texts: readonly string[]): number => {
    cases(side);
    const slot = result[side][0].variable?.length ?? 0;
    result[side].forEach((record, index) => {
      (record.variable ??= []).push({ text: texts[index] });
    });
    return slot + 1;
  };
  const token = (side: AxisSide, slot: number) =>
    `$${side === "rows" ? "ROW" : "COLUMN"}${slot}`;
  const literal = (text: string): string => {
    if (!numberedToken.test(text)) return text;
    numberedToken.lastIndex = 0;
    return token(
      "rows",
      fields(
        "rows",
        result.rows.map(() => text),
      ),
    );
  };
  for (const kind of [
    "size",
    "aspect_ratio",
    "quality",
    "background",
  ] as const) {
    if (old.format === "image")
      common(kind, old.imageSettings?.[kind] ?? "auto");
  }
  if (old.judge) {
    common("judge_model", old.judge.model);
    common("judge_effort", old.judge.effort);
  }
  for (const side of sides) {
    const axis = old[side];
    if (axis.kind === "variable") {
      // Slot one is the original axis-local value, even when historical
      // substring/cascade semantics require additional compiled slots below.
      fields(side, axis.values);
    } else if (
      axis.kind !== "input_references" &&
      !(old.format === "image" && axis.kind === "effort")
    ) {
      Object.assign(result.parameters, { [axis.kind]: { kind: side } });
      axis.values.forEach((selection, index) => {
        Object.assign(result[side][index], { [axis.kind]: selection });
      });
    }
  }
  if (old.judge) {
    // Production judging never interpolated criteria. Insert token-bearing
    // rubric text through literal field values, which are not recursively read.
    common(
      "judge_criteria",
      old.judge.criteria.map((criterion) => ({
        ...criterion,
        text: literal(criterion.text),
        weight: 1,
      })),
    );
  }
  const referenceAxis = sides.find(
    (side) => old[side].kind === "input_references",
  );
  // Thinking effort never affected native image generation. Preserve any
  // historical inert effort dimension as input/field-owned cases instead of
  // carrying an unsupported canonical image parameter.
  const inertEffortSide =
    old.format === "image"
      ? sides.find((side) => old[side].kind === "effort")
      : undefined;
  const inputSide: AxisSide =
    referenceAxis ?? (inertEffortSide === "rows" ? "columns" : "rows");
  const valueSide: AxisSide = inputSide === "rows" ? "columns" : "rows";
  const messages: ChatMessage[] =
    old.format === "chat-template"
      ? (old.messages ?? []).map((message) => ({ ...message }))
      : [{ role: "user", content: old.prompt }];
  const expand = (text: string, row: number, column: number) =>
    text
      .replaceAll("$ROW", () => old.rows.values[row])
      .replaceAll("$COLUMN", () => old.columns.values[column]);
  const compact = (text: string): string | undefined => {
    // Only whole bare historical tokens map directly. In production $ROW1,
    // $ROWS and $ROW_suffix were all substring replacements, not field names.
    const whole = /\$(ROW|COLUMN)(?![\p{L}\p{N}_])/gu;
    const remainder = text.replace(whole, "");
    if (remainder.includes("$ROW") || remainder.includes("$COLUMN")) return;
    if (
      text.includes("$ROW") &&
      (old.rows.kind !== "variable" ||
        old.rows.values.some((text) => text.includes("$COLUMN")))
    )
      return;
    if (text.includes("$COLUMN") && old.columns.kind !== "variable") return;
    return text.replace(whole, (_, side: string) => `$${side}1`);
  };
  let perCaseInput = !!referenceAxis;
  const compiled = result[inputSide].map(() =>
    messages.map((message) => ({ ...message })),
  );
  messages.forEach((message, messageIndex) => {
    const text = inertEffortSide ? undefined : compact(message.content);
    if (text !== undefined) {
      for (const input of compiled) input[messageIndex].content = text;
      return;
    }
    // Preserve the two physical axes: an input case selects a field slot on
    // the opposite axis. Field contents are fully resolved historical text,
    // so canonical single-pass interpolation cannot reinterpret literal tokens.
    perCaseInput = true;
    compiled.forEach((input, inputIndex) => {
      const slot = fields(
        valueSide,
        result[valueSide].map((_, valueIndex) =>
          expand(
            message.content,
            inputSide === "rows" ? inputIndex : valueIndex,
            inputSide === "columns" ? inputIndex : valueIndex,
          ),
        ),
      );
      input[messageIndex].content = token(valueSide, slot);
    });
  });
  const sharedReferences = old.inputReferences?.length
    ? old.inputReferences
    : old.imageSettings?.input_references?.map((id) => ({ id, name: id }));
  if (old.format === "image") {
    compiled.forEach((input, index) => {
      const images = referenceAxis
        ? (old.referenceGroups?.[old[referenceAxis].values[index]] ?? [])
        : (sharedReferences ?? []);
      // Native production image inputs always have one user prompt.
      if (images.length)
        input[0].images = images.map(({ id, name }) => ({
          id,
          name: name ?? id,
        }));
    });
  }
  if (perCaseInput) {
    cases(inputSide);
    result.parameters.input = { kind: inputSide };
    compiled.forEach((input, index) => {
      result[inputSide][index].input = input;
    });
  } else common("input", compiled[0]);
  // Structural canonical validation only: retired models and historical
  // provider choices are persisted, not readmitted against today's catalog.
  const canonical = gridDraftSchema.parse({
    ...result,
    budgetUsd: String(result.budgetUsd),
  });
  return { ...canonical, budgetUsd: result.budgetUsd };
}

export function migrateProductionGrid(
  value: unknown,
): Record<string, unknown> & { input: GridInput } {
  const grid = z.object({ input: z.unknown() }).passthrough().parse(value);
  return { ...grid, input: migrateProductionInput(grid.input) };
}
