import { useState, useEffect } from "react";
import { chatText, type GridInput } from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
export type Draft = {
  formatSelected: boolean;
  input: GridInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
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
    return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") ?? initial;
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
  const messages = d.input.messages ?? [
    { role: "user" as const, content: d.input.prompt },
  ];
  return {
    ...d,
    formatSelected: true,
    input: {
      ...d.input,
      format,
      messages: format === "chat" ? messages : undefined,
      prompt: format === "chat" ? chatText(messages) : d.input.prompt,
      imageSettings: undefined,
      inputReferences: undefined,
      model: "",
      effort: "default",
      rows:
        format === "markdown" || format === "chat"
          ? { kind: "effort", values: ["default"] }
          : { kind: "model", values: [] },
      columns:
        format === "image"
          ? { kind: "quality", values: ["auto"] }
          : format === "markdown" || format === "chat"
            ? { kind: "model", values: [] }
            : { kind: "effort", values: ["default"] },
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
    setDraft((d) => ({
      ...d,
      input: {
        ...d.input,
        inputReferences: d.input.inputReferences?.map((candidate) =>
          candidate.id === localId ? image : candidate,
        ),
        referenceGroups: Object.fromEntries(
          Object.entries(d.input.referenceGroups ?? {}).map(
            ([name, images]) => [
              name,
              images.map((candidate) =>
                candidate.id === localId ? image : candidate,
              ),
            ],
          ),
        ),
      },
    }));
  }
  function setReuseArtifacts(reuseArtifacts: boolean) {
    setDraft((d) => ({ ...d, reuseArtifacts }));
  }
  return { draft, update, selectFormat, replaceReference, setReuseArtifacts };
}
