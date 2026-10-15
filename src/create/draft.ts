import { useState } from "react";
import type { GridInput } from "../../server/domain";
import { storage } from "../api";
import { referenceFiles, removeReferenceFile } from "./reference-files";

export type Draft = Omit<GridInput, "format"> & {
  format?: GridInput["format"];
  sourceGridId?: string;
  reuseArtifacts: boolean;
  budgetText?: string;
};
export const draftKey = "slopgrid-draft";
export function clearDraft() {
  try {
    sessionStorage.removeItem(draftKey);
  } catch {}
  storage.remove("slopgrid-creation");
}
export function saveDraft(draft: Draft) {
  try {
    sessionStorage.setItem(draftKey, JSON.stringify({ input: draft }));
  } catch {}
}
export function emptyDraft(format?: GridInput["format"]): Draft {
  return {
    format,
    prompt: "",
    rows:
      format === "markdown"
        ? { kind: "effort", values: ["default"] }
        : { kind: "model", values: [] },
    columns:
      format === "image"
        ? { kind: "quality", values: ["auto"] }
        : format === "markdown"
          ? { kind: "model", values: [] }
          : { kind: "effort", values: ["default"] },
    model: "",
    effort: "default",
    budgetUsd: 3,
    reuseArtifacts: true,
  };
}
export function useDraft() {
  const [draft, setDraft] = useState(() => {
    try {
      return (
        (JSON.parse(sessionStorage.getItem(draftKey) ?? "null")
          ?.input as Draft) ?? emptyDraft()
      );
    } catch {
      return emptyDraft();
    }
  });
  const update = (next: Draft) => {
    saveDraft(next);
    setDraft(next);
    const retained = new Set(referenceFiles(next).map((image) => image.id));
    for (const image of referenceFiles(draft))
      if (image.id.startsWith("local-") && !retained.has(image.id))
        void removeReferenceFile(image.id).catch(() => {});
  };
  return [draft, update] as const;
}
export function changeAxis(
  draft: Draft,
  side: "rows" | "columns",
  kind: GridInput["rows"]["kind"],
): Draft {
  const other = side === "rows" ? "columns" : "rows";
  let next = { ...draft, [side]: { kind, values: [] as string[] } };
  if (kind in (draft.imageSettings ?? {}))
    next[side].values = [
      draft.imageSettings![kind as keyof typeof draft.imageSettings]!,
    ];
  const settings = { ...draft.imageSettings };
  delete settings[kind as keyof typeof settings];
  delete settings[draft[side].kind as keyof typeof settings];
  next.imageSettings = settings;
  if (kind === "input_references" && draft.inputReferences?.length) {
    next = {
      ...next,
      inputReferences: [],
      referenceGroups: {
        ...draft.referenceGroups,
        "Group 1": draft.inputReferences,
      },
    };
    next[side].values = ["Group 1"];
  }
  return next;
}
export function swapAxes(draft: Draft): Draft {
  return {
    ...draft,
    rows: draft.columns,
    columns: draft.rows,
    prompt: draft.prompt.replace(/\$ROW|\$COLUMN/g, (token) =>
      token === "$ROW" ? "$COLUMN" : "$ROW",
    ),
  };
}
