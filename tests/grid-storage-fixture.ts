import type Database from "better-sqlite3";
import { gridSchema, type Grid, type WorkflowTask } from "../server/domain.js";
import { selectedReferences } from "../server/image-settings.js";
import { expandPromptForTitle } from "../server/grid-title.js";
import type { Store } from "../server/store.js";
import { projectWorkflow } from "../server/workflow.js";

export function validatedGrid(grid: Grid) {
  return Object.assign(grid, { input: gridSchema.parse(grid.input) });
}

// Arrange already-accepted historical storage, never current API admission.
// Callers supply concrete task inputs and cell/task links; no workflow is rebuilt.
export function arrangeHistoricalGrid(
  store: Store,
  grid: Grid,
  tasks: readonly WorkflowTask[],
) {
  projectWorkflow(grid, tasks);
  const {
    id,
    owner,
    ownerUserId,
    published,
    visibility,
    slug,
    createdAt,
    cells,
    ...data
  } = grid;
  store.db.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO grids
        (id,data,owner,owner_user_id,published,visibility,slug,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        JSON.stringify({
          ...data,
          expanded_prompt_for_title: expandPromptForTitle(grid.input),
        }),
        owner,
        ownerUserId ?? null,
        published ? 1 : 0,
        visibility,
        slug ?? null,
        createdAt,
      );
    store.saveWorkflow(grid, tasks);
    const insertCell = store.db.prepare(
      "INSERT INTO cells (id,grid_id,position,data,generation_id,judgment_id) VALUES (?,?,?,'{}',?,?)",
    );
    cells.forEach((cell, position) =>
      insertCell.run(
        cell.id,
        id,
        position,
        cell.generationId,
        cell.judgmentId ?? null,
      ),
    );
    const insertReference = store.db.prepare(
      "INSERT INTO grid_reference_images (grid_id,reference_id) VALUES (?,?)",
    );
    for (const reference of selectedReferences(grid.input))
      insertReference.run(id, reference.id);
  })();
}

export function storedGridCount(db: Database.Database) {
  return db.prepare("SELECT COUNT(*) AS count FROM grids").get();
}

export function storedOwnerGridIds(db: Database.Database, owner: string) {
  return db.prepare("SELECT id FROM grids WHERE owner=?").all(owner);
}

export function removeStoredGrid(db: Database.Database, gridId: string) {
  db.prepare("DELETE FROM grids WHERE id=?").run(gridId);
}

export function storedPublicGridCreationTimes(db: Database.Database) {
  return db
    .prepare(
      "SELECT id, created_at AS createdAt FROM grids WHERE visibility='public'",
    )
    .all() as { id: string; createdAt: string }[];
}

export function rejectStoredGridUpdates(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER no_recompute BEFORE UPDATE ON grids BEGIN SELECT RAISE(ABORT, 'must not recompute'); END",
  );
}
