import { useState, useEffect } from "react";
import {
  chatText,
  isChatFormat,
  isMarkdownFormat,
  type ChatMessage,
  type GridInput,
} from "../../server/domain";
import {
  imageKinds,
  judgeReferences,
  type ReferenceImage,
} from "../../server/image-settings";
import { canJudge } from "../../server/compatibility";
import { modelCatalog } from "../model-catalog";
import { removeJudge } from "./change-axis";
import { migrateVariableInput } from "../../shared/variable-migration";
export type Draft = {
  formatSelected: boolean;
  input: GridInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
  inactiveChatMessages?: ChatMessage[];
  inactivePromptReferences?: ReferenceImage[];
  inactiveImageReferences?: Pick<
    GridInput,
    "inputReferences" | "referenceGroups"
  > & {
    rows?: GridInput["rows"];
    columns?: GridInput["columns"];
  };
};
function swapVariableTokens(text: string): string {
  return text.replace(
    /\$(ROW|COLUMN)([1-9]\d*)(?![\p{L}\p{N}_])/gu,
    (_, axis: string, number: string) =>
      `$${axis === "ROW" ? "COLUMN" : "ROW"}${number}`,
  );
}
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
    budgetUsd: 3,
  },
};
function readDraft(): Draft {
  try {
    const draft: Draft =
      JSON.parse(sessionStorage.getItem(storageKey) ?? "null") ?? initial;
    const originalInput = draft.input;
    draft.input = migrateVariableInput(originalInput) as GridInput;
    if (draft.inactiveChatMessages)
      draft.inactiveChatMessages = (
        migrateVariableInput({
          ...originalInput,
          messages: draft.inactiveChatMessages,
        }) as GridInput
      ).messages;
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
    if (draft.input.judge && !draft.input.judge.criteria.length) {
      Object.assign(draft.input, removeJudge(draft.input));
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
export function startDraft(format: GridInput["format"]) {
  saveDraft(selectDraftFormat(readDraft(), format));
}
function selectDraftFormat(d: Draft, format: GridInput["format"]): Draft {
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
  const rows: GridInput["rows"] =
    d.input.rows.kind === "variable"
      ? d.input.rows
      : format === "image" && imageReferences?.rows
        ? imageReferences.rows
        : isMarkdownFormat(format)
          ? { kind: "effort", values: ["default"] }
          : { kind: "model", values: [] };
  const columns: GridInput["columns"] =
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
  const imageInputs = judgeReferences(referenceInput).length > 0;
  return {
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
              effort: judgeEffort as GridInput["effort"],
              model: modelCatalog.some(
                (model) =>
                  model.id === judgeModel &&
                  canJudge(model, format, imageInputs),
              )
                ? judgeModel
                : "",
            },
      prompt: isChatFormat(format) ? chatText(messages) : d.input.prompt,
      imageSettings: undefined,
      model: "",
      effort: "default",
      rows,
      columns,
    },
  };
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
    change: Partial<GridInput> | ((input: GridInput) => Partial<GridInput>),
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
  function selectFormat(format: GridInput["format"]) {
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
    const replaceGroups = (groups: GridInput["referenceGroups"]) =>
      groups &&
      Object.fromEntries(
        Object.entries(groups).map(([name, images]) => [
          name,
          replaceImages(images)!,
        ]),
      );
    const replaceAxis = (axis: GridInput["rows"]): GridInput["rows"] =>
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
        judge: d.input.judge && {
          ...d.input.judge,
          criteria: d.input.judge.criteria.map((criterion) => ({
            ...criterion,
            text: swapVariableTokens(criterion.text),
          })),
        },
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
