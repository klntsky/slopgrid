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
  selectedReferences,
  type ReferenceImage,
} from "../../server/image-settings";
import { canJudge } from "../../server/compatibility";
import { modelCatalog } from "../model-catalog";
import { removeJudge } from "./change-axis";
export type Draft = {
  formatSelected: boolean;
  input: GridInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
  inactiveChatMessages?: ChatMessage[];
  inactiveImageReferences?: Pick<
    GridInput,
    "inputReferences" | "referenceGroups"
  > & {
    rows?: GridInput["rows"];
    columns?: GridInput["columns"];
  };
};
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
    if (isChatFormat(draft.input.format)) {
      const input = draft.input;
      const referenceAxis = [input.rows, input.columns].find(
        (axis) => axis.kind === "input_references",
      );
      const images = referenceAxis
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
        input.rows = { kind: "effort", values: ["default"] };
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
  const rows: GridInput["rows"] =
    format === "image" && imageReferences?.rows
      ? imageReferences.rows
      : isMarkdownFormat(format)
        ? { kind: "effort", values: ["default"] }
        : { kind: "model", values: [] };
  const columns: GridInput["columns"] =
    format === "image" && imageReferences?.columns
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
      format === "image" ? imageReferences?.inputReferences : undefined,
    referenceGroups:
      format === "image" ? imageReferences?.referenceGroups : undefined,
  };
  const judgeModel =
    [d.input.rows, d.input.columns].find((axis) => axis.kind === "judge_model")
      ?.values[0] ??
    d.input.judge?.model ??
    "";
  const judgeEffort =
    [d.input.rows, d.input.columns].find((axis) => axis.kind === "judge_effort")
      ?.values[0] ??
    d.input.judge?.effort ??
    "default";
  const imageInputs = selectedReferences(referenceInput).length > 0;
  return {
    ...d,
    formatSelected: true,
    inactiveChatMessages: isChatFormat(format)
      ? undefined
      : (d.input.messages ?? d.inactiveChatMessages),
    inactiveImageReferences: format === "image" ? undefined : imageReferences,
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
    setDraft((d) => ({
      ...d,
      input: {
        ...d.input,
        messages: replaceMessages(d.input.messages),
        inputReferences: replaceImages(d.input.inputReferences),
        referenceGroups: replaceGroups(d.input.referenceGroups),
      },
      inactiveChatMessages: replaceMessages(d.inactiveChatMessages),
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
  function setReuseArtifacts(reuseArtifacts: boolean) {
    setDraft((d) => ({ ...d, reuseArtifacts }));
  }
  return { draft, update, selectFormat, replaceReference, setReuseArtifacts };
}
