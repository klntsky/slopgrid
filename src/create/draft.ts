import { gridDraftSchema } from "../../server/domain";
import { defaultGridDraft, parameterDefault } from "../../server/parameters";
import type { Draft } from "./machine-contract";
import { creationDraftCodec, equalCreationData } from "./machine-codec";

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
export function readDraft(): Draft {
  let migrated = false;
  let draft: Draft;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!saved || saved.input?.inputVersion !== 3) return initial();
    if (
      saved.input.judge === true &&
      saved.input.parameters &&
      !Object.hasOwn(saved.input.parameters, "judge_system")
    ) {
      saved.input.parameters.judge_system = {
        kind: "common",
        value: parameterDefault("judge_system"),
      };
      migrated = true;
    }
    draft = creationDraftCodec.parse({
      formatSelected: saved.formatSelected,
      input: gridDraftSchema.parse(saved.input),
      sourceGridId: saved.sourceGridId,
      reuseArtifacts: saved.reuseArtifacts,
    });
    migrated ||= !equalCreationData(saved, draft);
  } catch {
    return initial();
  }
  if (migrated) saveDraft(draft);
  return draft;
}
export function saveDraft(draft: Draft) {
  sessionStorage.setItem(storageKey, JSON.stringify(draft));
}
export function clearDraft() {
  sessionStorage.removeItem(storageKey);
  sessionStorage.removeItem(submissionKey);
}
