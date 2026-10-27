import type Database from "better-sqlite3";
import assert from "node:assert/strict";
import type { ViewGrid } from "../src/api.js";
import { gridSchema, type Grid } from "../server/domain.js";
import { Provider } from "../server/provider.js";
import { prepareGridModels } from "../server/model-resolution.js";
import { createWorkflow, projectWorkflow } from "../server/workflow.js";
import { reuseArtifacts } from "../server/artifact-reuse.js";
import { token } from "../server/ids.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import type { RuntimeFixture } from "./runtime-fixture.js";

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
export async function reuseCandidate(
  f: RuntimeFixture,
  definition: unknown,
  sourceId: string,
  reuse: boolean,
) {
  const provider = new Provider(f.providerURL);
  const prepared = prepareGridModels(
    f.store.references.input(gridSchema.parse(definition)),
    await provider.models(),
  );
  const grid: Grid = {
    id: token(),
    owner: f.owner,
    ownerUserId: f.store.session(f.owner)?.userId,
    input: prepared.input,
    status: "paused",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: prepared.cells.map((cell) => ({ ...cell, id: token() })),
  };
  const tasks = createWorkflow(prepared.input, grid.cells, prepared.models);
  const source = f.store.get(sourceId);
  assert.ok(source);
  if (reuse) await reuseArtifacts(f.store, provider, source, tasks);
  projectWorkflow(grid, tasks);
  if (grid.cells.every((cell) => cell.status === "complete"))
    grid.status = "complete";
  f.store.insert(validatedGrid(grid), tasks);
  if (grid.status !== "complete")
    await f.engine.api.startGrid({
      gridId: grid.id,
      sessionId: f.owner,
      manualKey: "manual-test-key",
    });
  const response = await f.request(`/api/grids/${grid.id}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as ViewGrid;
}
