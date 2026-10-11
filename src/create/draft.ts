import { useState, useEffect } from "react";
import type { GridInput } from "../../server/domain";
export type Draft = { step: number; input: GridInput };
const initial: Draft = {
  step: 0,
  input: {
    format: "svg",
    prompt: "",
    rows: { kind: "effort", values: [] },
    columns: { kind: "model", values: [] },
    model: "",
    effort: "default",
    harness: "direct",
    budgetUsd: 5,
  },
};
function readDraft(): Draft {
  try {
    return (
      JSON.parse(sessionStorage.getItem("slopgrid-draft") ?? "null") ?? initial
    );
  } catch {
    return initial;
  }
}
export function useCreateDraft() {
  const [draft, setDraft] = useState(readDraft);
  useEffect(() => {
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
  }, [draft]);
  return [draft, setDraft] as const;
}
