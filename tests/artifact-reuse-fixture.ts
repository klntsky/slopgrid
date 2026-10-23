import type Database from "better-sqlite3";

// Frozen from master ebd1243: Markdown, default effort, fixture/text at $1/M
// input/output tokens. Unlike a current-adapter reconstruction, this detects
// request-signature drift across the production cutover.
export const masterPlainPrompt = {
  model: "fixture/text",
  prompt: "A reusable plain prompt",
  signature: "6ee9059025297416e039e3b1dfd99800d5f4a3138ec4bdb427201ef0e8625c53",
};

export function removeTemplateInputTokenUsage(
  db: Database.Database,
  generationId: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance.templateSteps[1].usage.inputTokens') WHERE id=?",
  ).run(generationId);
}

export function removeSecondTemplateStep(
  db: Database.Database,
  generationId: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance.templateSteps[1]') WHERE id=?",
  ).run(generationId);
}

export function removeGenerationProvenance(
  db: Database.Database,
  generationId: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance') WHERE id=?",
  ).run(generationId);
}

export function removeGridGenerationProvenance(
  db: Database.Database,
  gridId: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_remove(data,'$.output.provenance') WHERE grid_id=? AND kind='generation'",
  ).run(gridId);
}

export function removeInferenceOutputTokenUsage(
  db: Database.Database,
  cellId: string,
) {
  db.prepare(
    "UPDATE inference_calls SET data=json_remove(data,'$.usage.outputTokens') WHERE cell_id=?",
  ).run(cellId);
}

export function staleGenerationProvenance(
  db: Database.Database,
  generationId: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_set(data,'$.output.provenance.signature','stale-adapter-policy') WHERE id=?",
  ).run(generationId);
}

export function removeArtifactSourceGrid(
  db: Database.Database,
  gridId: string,
) {
  db.transaction(() => {
    db.prepare(
      "DELETE FROM inference_calls WHERE cell_id IN (SELECT id FROM cells WHERE grid_id=?)",
    ).run(gridId);
    db.prepare("DELETE FROM grids WHERE id=?").run(gridId);
  })();
}

export function restorePlainPromptGeneration(
  db: Database.Database,
  generationId: string,
  signature: string,
) {
  db.prepare(
    "UPDATE workflow_tasks SET data=json_set(json_remove(data,'$.input.messages'),'$.output.provenance.signature',?) WHERE id=?",
  ).run(signature, generationId);
}
