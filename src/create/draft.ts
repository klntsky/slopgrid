import { useState, useEffect } from "react";
import {
  chatText,
  gridDraftSchema,
  isChatFormat,
  type ChatMessage,
  type GridDraftInput,
} from "../../server/domain";
import { type ReferenceImage } from "../../server/image-settings";
import { defaultGridDraft, axisParameters } from "../../server/parameters";
import {
  confirmInputAction,
  reduceInput,
  type InputAction,
} from "./change-axis";
import { swapVariableTokens } from "./judge-mode";
import { referenceLists } from "./reference-files";
import { canJudge } from "../../server/compatibility";
import { modelCatalog } from "../model-catalog";

export type Draft = {
  formatSelected: boolean;
  input: GridDraftInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
  inactiveChatMessages?: ChatMessage[];
  inactivePromptImages?: ReferenceImage[];
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
const initial = (): Draft => ({
  formatSelected: false,
  input: defaultGridDraft("svg"),
});
function readDraft(): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!saved || saved.input?.inputVersion !== 2) return initial();
    return { ...saved, input: gridDraftSchema.parse(saved.input) };
  } catch {
    return initial();
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
  const draft = readDraft();
  if (confirmFormatChange(draft, format))
    saveDraft(selectDraftFormat(draft, format));
}

function confirmFormatChange(
  draft: Draft,
  format: GridDraftInput["format"],
): boolean {
  if (draft.input.format === format) return true;
  // Format changes reset non-variable dimensions, never silently choosing a case's judge values.
  for (const parameter of [
    "judge_model",
    "judge_effort",
    "judge_criteria",
  ] as const) {
    const source = draft.input.parameters[parameter];
    if (
      source &&
      source.kind !== "common" &&
      source.kind !== draft.input.parameters.variable?.kind &&
      !confirmInputAction(draft.input, { type: "to-common", parameter })
    )
      return false;
  }
  return true;
}

function selectDraftFormat(
  draft: Draft,
  format: GridDraftInput["format"],
): Draft {
  if (draft.input.format === format) return { ...draft, formatSelected: true };
  const previous = draft.input;
  const messages = previous.messages ??
    draft.inactiveChatMessages ?? [
      { role: "user" as const, content: previous.prompt },
    ];
  const promptImages = isChatFormat(previous.format)
    ? (draft.inactivePromptImages ?? [])
    : previous.promptImages;
  let input = {
    ...defaultGridDraft(format),
    budgetUsd: previous.budgetUsd,
    prompt: previous.prompt,
    promptImages: isChatFormat(format) ? [] : promptImages,
  };
  const variable = previous.parameters.variable;
  if (variable) {
    // Keep numbered fields, not a hidden copy of the previous format's settings.
    for (const parameter of axisParameters(input, variable.kind))
      if (parameter !== "variable")
        input = reduceInput(input, { type: "to-common", parameter });
    input = {
      ...input,
      parameters: { ...input.parameters, variable },
      [variable.kind]: previous[variable.kind].map((entry) => ({
        id: entry.id,
        variable: entry.variable,
      })),
    };
  }
  if (previous.judge && format !== "html") {
    input = reduceInput(input, { type: "judge", enabled: true });
    for (const parameter of [
      "judge_model",
      "judge_effort",
      "judge_criteria",
    ] as const) {
      const source = previous.parameters[parameter];
      if (!source) continue;
      if (source.kind !== "common" && variable?.kind === source.kind) {
        input = {
          ...input,
          parameters: { ...input.parameters, [parameter]: source },
          [source.kind]: input[source.kind].map((entry, index) => ({
            ...entry,
            [parameter]: previous[source.kind][index][parameter],
          })),
        };
      } else {
        const collapsed = reduceInput(previous, {
          type: "to-common",
          parameter,
        });
        Object.assign(input.parameters, {
          [parameter]: collapsed.parameters[parameter],
        });
      }
    }
  }
  if (isChatFormat(format))
    input = { ...input, messages, prompt: chatText(messages) };
  const judgeModel = input.parameters.judge_model;
  if (judgeModel?.kind === "common" && judgeModel.value) {
    const model = modelCatalog.find((model) => model.id === judgeModel.value);
    if (!model || !canJudge(model, format))
      input = reduceInput(input, {
        type: "common",
        parameter: "judge_model",
        value: "",
      });
  }
  return {
    ...draft,
    formatSelected: true,
    input,
    inactiveChatMessages: isChatFormat(format)
      ? undefined
      : (previous.messages ?? draft.inactiveChatMessages),
    inactivePromptImages: isChatFormat(format) ? promptImages : undefined,
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
    change:
      | Partial<GridDraftInput>
      | ((input: GridDraftInput) => Partial<GridDraftInput>),
  ) {
    setDraft((draft) => {
      const partial =
        typeof change === "function" ? change(draft.input) : change;
      return {
        ...draft,
        input: {
          ...draft.input,
          ...partial,
          ...(partial.messages && { prompt: chatText(partial.messages) }),
        },
      };
    });
  }
  function dispatch(action: InputAction) {
    if (!confirmInputAction(draft.input, action)) return false;
    setDraft((draft) => ({
      ...draft,
      input: reduceInput(draft.input, action),
      ...(action.type === "swap" && {
        inactiveChatMessages: draft.inactiveChatMessages?.map((message) => ({
          ...message,
          content: swapVariableTokens(message.content),
        })),
      }),
    }));
    return true;
  }
  function selectFormat(format: GridDraftInput["format"]) {
    if (!confirmFormatChange(draft, format)) return;
    setDraft((draft) => selectDraftFormat(draft, format));
  }
  function replaceReference(localId: string, image: ReferenceImage) {
    setDraft((draft) => {
      const next = structuredClone(draft);
      const lists = [
        ...referenceLists(next.input),
        ...(next.inactiveChatMessages ?? []).flatMap((message) =>
          message.images ? [message.images] : [],
        ),
        ...(next.inactivePromptImages ? [next.inactivePromptImages] : []),
      ];
      for (const images of lists)
        for (let index = 0; index < images.length; index++)
          if (images[index].id === localId) images[index] = image;
      return next;
    });
  }
  return {
    draft,
    update,
    dispatch,
    selectFormat,
    replaceReference,
    setReuseArtifacts: (reuseArtifacts: boolean) =>
      setDraft((draft) => ({ ...draft, reuseArtifacts })),
  };
}
