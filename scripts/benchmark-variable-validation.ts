import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import {
  validateDraftInput,
  compatibilityPreviewInput,
} from "../src/create/draft-input.js";
import {
  promptVariableIssues,
  promptVariableIssue,
} from "../server/prompt-variables.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";
import { estimateGrid } from "../server/cost-estimates.js";
import type { GridDraftInput, GridInput } from "../server/domain.js";
import type { Model } from "../server/provider.js";

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "10,25,50,100,200,400,800,1600" },
    rows: { type: "string", default: "1" },
    columns: { type: "string", default: "1" },
    references: { type: "string", default: "all" },
    numbered: { type: "boolean", default: false },
    judge: { type: "boolean", default: false },
    "repeat-variable-guard": { type: "boolean", default: false },
    samples: { type: "string", default: "31" },
    warmup: { type: "string", default: "10" },
    output: { type: "string" },
    workloads: { type: "string" },
  },
});
const positive = (value: string, name: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
};
const sizes = values.sizes!.split(",").map((size) => positive(size, "size"));
const rows = positive(values.rows!, "rows");
const columns = positive(values.columns!, "columns");
const samples = positive(values.samples!, "samples");
const warmup = positive(values.warmup!, "warmup");
if (!["all", "last"].includes(values.references!))
  throw new Error("references must be all or last");
const models: Model[] = [
  {
    id: "fixture/text",
    name: "Fixture text",
    text: true,
    image: false,
    imageInput: true,
    reasoning: true,
    reasoningMandatory: false,
    structuredOutputs: true,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 1000000,
    maxCompletionTokens: 1000,
  },
];
const now = new Date("2026-10-25T00:00:00Z");
function workload(size: number): GridDraftInput {
  const names = Array.from({ length: size }, (_, index) =>
    values.numbered ? `ROW${index + 1}` : `FIELD_${index + 1}`,
  );
  const tokens = values.references === "last" ? [names.at(-1)!] : names;
  const prompt = `Compare ${tokens.map((name) => `$${name}`).join(" ")}`;
  return {
    inputVersion: 3,
    format: "svg",
    budgetUsd: "3",
    judge: values.judge,
    caseAxes: ["rows"],
    ...(!values.numbered ? { variableNames: { rows: names } } : {}),
    parameters: {
      input: { kind: "common", value: [{ role: "user", content: prompt }] },
      model: { kind: "columns" },
      effort: { kind: "common", value: "default" },
      ...(values.judge
        ? {
            judge_model: { kind: "common" as const, value: models[0].id },
            judge_effort: {
              kind: "common" as const,
              value: "default" as const,
            },
            judge_criteria: {
              kind: "common" as const,
              value: [
                {
                  text: `Check ${tokens.map((name) => `$${name}`).join(" ")}`,
                  correctAnswer: true,
                },
              ],
            },
          }
        : {}),
    },
    rows: Array.from({ length: rows }, (_, row) => ({
      id: `row-${row}`,
      variable: names.map((_, index) => ({ text: `v${row}_${index}` })),
    })),
    columns: Array.from({ length: columns }, (_, column) => ({
      id: `column-${column}`,
      model: models[0].id,
    })),
  };
}
function candidate(draft: GridDraftInput): GridInput {
  return { ...draft, budgetUsd: 3 };
}
function nextDraft(draft: GridDraftInput, sample: number): GridDraftInput {
  const first = draft.rows[0];
  return {
    ...draft,
    rows: [
      {
        ...first,
        variable: first.variable!.map((field, index) =>
          index === 0 ? { ...field!, text: `edit${sample}` } : field,
        ),
      },
      ...draft.rows.slice(1),
    ],
  };
}
function measure(
  draft: GridDraftInput,
  run: (draft: GridDraftInput) => unknown,
) {
  for (let index = 0; index < warmup; index++) run(nextDraft(draft, index));
  const rawMs: number[] = [];
  for (let index = 0; index < samples; index++) {
    const changed = nextDraft(draft, index);
    const started = performance.now();
    run(changed);
    rawMs.push(performance.now() - started);
  }
  const sorted = [...rawMs].sort((left, right) => left - right);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    rawMs,
  };
}
const stages = {
  variables: (draft: GridDraftInput) => promptVariableIssues(candidate(draft)),
  validation: (draft: GridDraftInput) => validateDraftInput(draft),
  compatibility: (draft: GridDraftInput) =>
    analyzeGridCompatibility(
      compatibilityPreviewInput(candidate(draft)),
      models,
    ),
  budgetGuard: (draft: GridDraftInput) => promptVariableIssue(candidate(draft)),
  budget: (draft: GridDraftInput) =>
    estimateGrid(candidate(draft), models, now),
  editAnalysis: (draft: GridDraftInput) => {
    const validation = validateDraftInput(draft);
    if (
      (!values["repeat-variable-guard"] && validation.parsed.success) ||
      !promptVariableIssue(validation.candidate)
    )
      estimateGrid(validation.candidate, models, now);
    return analyzeGridCompatibility(
      compatibilityPreviewInput(validation.candidate),
      models,
    );
  },
};
const records = [];
const workloads = [];
for (const size of sizes) {
  const draft = workload(size);
  const valid = validateDraftInput(draft).parsed;
  if (!valid.success) throw new Error(valid.error.message);
  const measurements = Object.fromEntries(
    Object.entries(stages).map(([stage, run]) => [stage, measure(draft, run)]),
  );
  records.push({
    variables: size,
    references: values.references === "all" ? size : 1,
    rows,
    columns,
    cells: rows * columns,
    named: !values.numbered,
    judge: values.judge,
    measurements,
  });
  workloads.push({
    variables: size,
    draft: { input: draft, formatSelected: true },
  });
  console.error(
    JSON.stringify({
      variables: size,
      stages: Object.fromEntries(
        Object.entries(measurements).map(([stage, result]) => [
          stage,
          result.medianMs,
        ]),
      ),
    }),
  );
}
const report = {
  runtime: process.version,
  cpu: cpus()[0]?.model,
  cpuThrottling: 1,
  reuseSuccessfulValidation: !values["repeat-variable-guard"],
  samples,
  warmup,
  records,
};
if (values.output)
  writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
else console.log(JSON.stringify(report, null, 2));
if (values.workloads)
  writeFileSync(values.workloads, JSON.stringify(workloads) + "\n");
