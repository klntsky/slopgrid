import { useState, useEffect } from "react";
import type { GridInput } from "../../server/domain";
export type Draft = {
  formatSelected: boolean;
  input: GridInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
};
const storageKey = "slopgrid-draft";
const initial: Draft = {
  formatSelected: false,
  input: {
    format: "svg",
    prompt: "",
    rows: { kind: "model", values: [] },
    columns: { kind: "effort", values: [] },
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
}
export function useCreateDraft() {
  const [draft, setDraft] = useState(readDraft);
  useEffect(() => {
    saveDraft(draft);
  }, [draft]);
  return [draft, setDraft] as const;
}
