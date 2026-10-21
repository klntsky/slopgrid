import { useState, useEffect } from "react";
import { z } from "zod";
import {
  chatText,
  isChatFormat,
  isMarkdownFormat,
  gridDraftSchema,
  type ChatMessage,
  type GridDraftInput,
} from "../../server/domain";
import { imageKinds, type ReferenceImage } from "../../server/image-settings";
import { migrateVariableInput } from "../../shared/variable-migration";
import { swapJudgeAxes, swapVariableTokens } from "./judge-mode";
import { analyzeGridCompatibility } from "../../server/grid-compatibility";
import { modelCatalog } from "../model-catalog";
import { compatibilityPreviewInput, validateDraftInput } from "./draft-input";
export type Draft = {
  formatSelected: boolean;
  input: GridDraftInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
  inactiveChatMessages?: ChatMessage[];
  inactivePromptReferences?: ReferenceImage[];
  inactiveImageReferences?: Pick<
    GridDraftInput,
    "inputReferences" | "referenceGroups"
  > & {
    rows?: GridDraftInput["rows"];
    columns?: GridDraftInput["columns"];
  };
};
const savedDraftSchema = z.object({
  formatSelected: z.boolean(),
  input: gridDraftSchema,
  sourceGridId: z.string().optional(),
  reuseArtifacts: z.boolean().optional(),
  inactiveChatMessages: gridDraftSchema.shape.messages,
  inactivePromptReferences: gridDraftSchema.shape.inputReferences,
  inactiveImageReferences: z
    .object({
      inputReferences: gridDraftSchema.shape.inputReferences,
      referenceGroups: gridDraftSchema.shape.referenceGroups,
      rows: gridDraftSchema.shape.rows.optional(),
      columns: gridDraftSchema.shape.columns.optional(),
    })
    .optional(),
});
const storageKey = "slopgrid-draft";
const submissionKey = "slopgrid-creation";
export function creationSubmission(body: Record<string, unknown>) {
  // Automatic capacity can change between retries; the submitted request cannot.
  const { parallelWorkers: _workers, ...intent } = body;
  const fingerprint = JSON.stringify(intent);
  const previous = JSON.parse(sessionStorage.getItem(submissionKey) ?? "null");
  if (previous?.fingerprint === fingerprint)
    return previous.body as Record<string, unknown>;
  const request = { ...body, creationRequestId: crypto.randomUUID() };
  sessionStorage.setItem(
    submissionKey,
    JSON.stringify({ fingerprint, body: request }),
  );
  return request;
}
const initial: Draft = {
  formatSelected: false,
  input: {
    format: "svg",
    prompt: "",
    rows: { kind: "model", values: [] },
    columns: { kind: "effort", values: ["default"] },
    model: "",
    effort: "default",
    budgetUsd: "3",
  },
};
function readDraft(): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!saved) return initial;
    const originalInput = saved.input;
    const budget = originalInput.budgetUsd;
    const normalizedInput = {
      ...originalInput,
      budgetUsd:
        typeof budget === "number"
          ? Number.isFinite(budget)
            ? String(budget)
            : ""
          : budget === null
            ? ""
            : budget,
    };
    const draft: Draft = savedDraftSchema.parse({
      ...saved,
      input: migrateVariableInput(normalizedInput),
      inactiveChatMessages: saved.inactiveChatMessages
        ? gridDraftSchema.parse(
            migrateVariableInput({
              ...normalizedInput,
              messages: saved.inactiveChatMessages,
            }),
          ).messages
        : undefined,
    });
    if (isChatFormat(draft.input.format)) {
      const input = draft.input;
      const referenceAxis = [input.rows, input.columns].find(
        (axis) => axis.kind === "input_references",
      );
      const images =
        referenceAxis?.kind === "input_references"
          ? referenceAxis.values.flatMap(
              (name) => input.referenceGroups?.[name] ?? [],
            )
          : (input.inputReferences ?? []);
      if (images.length) {
        const messages = [...(input.messages ?? [])];
        const user = messages.findIndex((message) => message.role === "user");
        if (user < 0) messages.push({ role: "user", content: "", images });
        else
          messages[user] = {
            ...messages[user],
            images: [...(messages[user].images ?? []), ...images],
          };
        input.messages = messages;
        input.prompt = chatText(messages);
      }
      delete input.inputReferences;
      delete input.referenceGroups;
      if (
        [input.rows, input.columns].some((axis) =>
          imageKinds.some((kind) => kind === axis.kind),
        )
      ) {
        if (input.rows.kind !== "variable")
          input.rows = { kind: "effort", values: ["default"] };
        if (input.columns.kind !== "variable")
          input.columns = { kind: "model", values: [] };
      }
    }
    return draft;
  } catch {
    return initial;
  }
}
export function saveDraft(draft: Draft) {
  sessionStorage.setItem(storageKey, JSON.stringify(draft));
}
export function clearDraft() {
  sessionStorage.removeItem(storageKey);
  sessionStorage.removeItem(submissionKey);
}
export function startDraft(format: GridDraftInput["format"]) {
  saveDraft(selectDraftFormat(readDraft(), format));
}
function selectDraftFormat(d: Draft, format: GridDraftInput["format"]): Draft {
  const messages = d.input.messages ??
    d.inactiveChatMessages ?? [
      { role: "user" as const, content: d.input.prompt },
    ];
  const imageReferences =
    d.input.format === "image"
      ? {
          inputReferences: d.input.inputReferences,
          referenceGroups: d.input.referenceGroups,
          rows:
            d.input.rows.kind === "input_references" ? d.input.rows : undefined,
          columns:
            d.input.columns.kind === "input_references"
              ? d.input.columns
              : undefined,
        }
      : d.inactiveImageReferences;
  const promptReferences =
    d.input.format !== "image" && !isChatFormat(d.input.format)
      ? d.input.inputReferences
      : d.inactivePromptReferences;
  const rows: GridDraftInput["rows"] =
    d.input.rows.kind === "variable"
      ? d.input.rows
      : format === "image" && imageReferences?.rows
        ? imageReferences.rows
        : isMarkdownFormat(format)
          ? { kind: "effort", values: ["default"] }
          : { kind: "model", values: [] };
  const columns: GridDraftInput["columns"] =
    d.input.columns.kind === "variable"
      ? d.input.columns
      : format === "image" && imageReferences?.columns
        ? imageReferences.columns
        : format === "image"
          ? { kind: "quality", values: ["auto"] }
          : isMarkdownFormat(format)
            ? { kind: "model", values: [] }
            : { kind: "effort", values: ["default"] };
  const referenceInput = {
    ...d.input,
    format,
    rows,
    columns,
    messages: isChatFormat(format) ? messages : undefined,
    inputReferences:
      format === "image"
        ? imageReferences?.inputReferences
        : isChatFormat(format)
          ? undefined
          : promptReferences,
    referenceGroups:
      format === "image" ? imageReferences?.referenceGroups : undefined,
  };
  const scalarAxes = [d.input.rows, d.input.columns].filter(
    (axis) => axis.kind !== "variable",
  );
  const judgeModel =
    scalarAxes.find((axis) => axis.kind === "judge_model")?.values[0] ??
    d.input.judge?.model ??
    "";
  const judgeEffort =
    scalarAxes.find((axis) => axis.kind === "judge_effort")?.values[0] ??
    d.input.judge?.effort ??
    "default";
  const next: Draft = {
    ...d,
    formatSelected: true,
    inactiveChatMessages: isChatFormat(format)
      ? undefined
      : (d.input.messages ?? d.inactiveChatMessages),
    inactiveImageReferences: format === "image" ? undefined : imageReferences,
    inactivePromptReferences:
      format === "image" || isChatFormat(format) ? promptReferences : undefined,
    input: {
      ...referenceInput,
      judge:
        format === "html"
          ? undefined
          : d.input.judge && {
              ...d.input.judge,
              effort: judgeEffort as GridDraftInput["effort"],
              model: judgeModel,
            },
      prompt: isChatFormat(format) ? chatText(messages) : d.input.prompt,
      imageSettings: undefined,
      model: "",
      effort: "default",
      rows,
      columns,
    },
  };
  if (
    next.input.judge?.model &&
    analyzeGridCompatibility(
      compatibilityPreviewInput(validateDraftInput(next.input).candidate),
      modelCatalog,
    ).issues.some(
      (issue) =>
        issue.blocking &&
        issue.origins.some((origin) => origin.parameter === "judge_model"),
    )
  )
    next.input.judge = { ...next.input.judge, model: "" };
  return next;
}
export function useCreateDraft() {
  const [draft, setDraft] = useState(() => ({
    ...readDraft(),
    formatSelected: true,
  }));
  useEffect(() => {
    saveDraft(draft);
  }, [draft]);
  function update(
    change:
      | Partial<GridDraftInput>
      | ((input: GridDraftInput) => Partial<GridDraftInput>),
  ) {
    setDraft((d) => {
      const partial = typeof change === "function" ? change(d.input) : change;
      if (partial.messages) partial.prompt = chatText(partial.messages);
      return {
        ...d,
        input: {
          ...d.input,
          ...partial,
          referenceGroups: partial.referenceGroups
            ? { ...d.input.referenceGroups, ...partial.referenceGroups }
            : d.input.referenceGroups,
        },
      };
    });
  }
  function selectFormat(format: GridDraftInput["format"]) {
    setDraft((d) => selectDraftFormat(d, format));
  }
  function replaceReference(localId: string, image: ReferenceImage) {
    const replaceImages = (images: readonly ReferenceImage[] | undefined) =>
      images?.map((candidate) =>
        candidate.id === localId ? image : candidate,
      );
    const replaceMessages = (messages: ChatMessage[] | undefined) =>
      messages?.map((message) => ({
        ...message,
        ...(message.images && { images: replaceImages(message.images) }),
      }));
    const replaceGroups = (groups: GridDraftInput["referenceGroups"]) =>
      groups &&
      Object.fromEntries(
        Object.entries(groups).map(([name, images]) => [
          name,
          replaceImages(images)!,
        ]),
      );
    const replaceAxis = (
      axis: GridDraftInput["rows"],
    ): GridDraftInput["rows"] =>
      axis.kind === "variable"
        ? {
            ...axis,
            values: axis.values.map((entry) =>
              entry.map((field) => ({
                ...field,
                ...(field.images && { images: replaceImages(field.images) }),
              })),
            ),
          }
        : axis;
    setDraft((d) => ({
      ...d,
      input: {
        ...d.input,
        rows: replaceAxis(d.input.rows),
        columns: replaceAxis(d.input.columns),
        messages: replaceMessages(d.input.messages),
        inputReferences: replaceImages(d.input.inputReferences),
        referenceGroups: replaceGroups(d.input.referenceGroups),
      },
      inactiveChatMessages: replaceMessages(d.inactiveChatMessages),
      inactivePromptReferences: replaceImages(d.inactivePromptReferences),
      inactiveImageReferences: d.inactiveImageReferences && {
        ...d.inactiveImageReferences,
        inputReferences: replaceImages(
          d.inactiveImageReferences.inputReferences,
        ),
        referenceGroups: replaceGroups(
          d.inactiveImageReferences.referenceGroups,
        ),
      },
    }));
  }
  function swapAxes() {
    setDraft((d) => ({
      ...d,
      input: {
        ...d.input,
        rows: d.input.columns,
        columns: d.input.rows,
        prompt: swapVariableTokens(d.input.prompt),
        messages: d.input.messages?.map((message) => ({
          ...message,
          content: swapVariableTokens(message.content),
        })),
        judge: swapJudgeAxes(d.input.judge),
      },
      inactiveChatMessages: d.inactiveChatMessages?.map((message) => ({
        ...message,
        content: swapVariableTokens(message.content),
      })),
      inactiveImageReferences: d.inactiveImageReferences && {
        ...d.inactiveImageReferences,
        rows: d.inactiveImageReferences.columns,
        columns: d.inactiveImageReferences.rows,
      },
    }));
  }
  function setReuseArtifacts(reuseArtifacts: boolean) {
    setDraft((d) => ({ ...d, reuseArtifacts }));
  }
  return {
    draft,
    update,
    selectFormat,
    swapAxes,
    replaceReference,
    setReuseArtifacts,
  };
}
