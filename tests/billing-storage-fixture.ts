import type Database from "better-sqlite3";

export function storedInferenceCallPayloads(db: Database.Database) {
  return db
    .prepare("SELECT data FROM inference_calls ORDER BY started_at, rowid")
    .all() as { data: string }[];
}

export function giveInferenceCallsEqualTimestamps(db: Database.Database) {
  db.prepare("UPDATE inference_calls SET started_at=100").run();
}

export function inferenceCallIdsNewestInsertedFirst(db: Database.Database) {
  return db
    .prepare("SELECT id FROM inference_calls ORDER BY rowid DESC")
    .all() as { id: string }[];
}

export function storedCellInferenceFailure(
  db: Database.Database,
  cellId: string,
) {
  const row = db
    .prepare("SELECT status,data FROM inference_calls WHERE cell_id=?")
    .get(cellId) as { status: string; data: string };
  return { ...JSON.parse(row.data), status: row.status };
}
