import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { migrateGridData } from "./database.js";
import { MigrationOutputFiles } from "./migration-output-files.js";
import { InvalidHistoricalChat, migrateChatExecutionPlans } from "./chat-execution-plan-migration.js";
import { readChatOutput } from "../shared/chat-output.js";
import type { Model } from "./provider.js";

const input = workerData as {
  snapshot: string;
  directory: string;
  sourceOutputs: string;
  gridId: string;
  version: number;
  models: readonly Model[];
};
const database = join(input.directory, "grid.sqlite");
const files = join(input.directory, "files");
mkdirSync(input.directory, { recursive: true, mode: 0o700 });
const source = new Database(input.snapshot, { readonly: true });
const db = new Database(database);
// Grid-local subgraphs omit global owners; check foreign keys on the assembled snapshot.
db.pragma("foreign_keys = OFF");
try {
  const tables = [
    "grids", "workflow_tasks", "reference_blobs", "reference_images",
    "grid_reference_images",
  ];
  for (const table of tables) {
    const row = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string };
    db.exec(row.sql);
  }
  db.prepare("ATTACH DATABASE ? AS snapshot").run(input.snapshot);
  db.prepare("INSERT INTO grids SELECT * FROM snapshot.grids WHERE id=?").run(input.gridId);
  db.prepare("INSERT INTO workflow_tasks SELECT * FROM snapshot.workflow_tasks WHERE grid_id=?").run(input.gridId);
  db.prepare("INSERT INTO grid_reference_images SELECT * FROM snapshot.grid_reference_images WHERE grid_id=?").run(input.gridId);
  const referenceIds = new Set<string>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.id === "string") referenceIds.add(record.id);
      for (const entry of Object.values(record)) collect(entry);
    }
  }
  for (const row of db.prepare("SELECT data FROM grids UNION ALL SELECT data FROM workflow_tasks").iterate() as Iterable<{data: string}>)
    collect(JSON.parse(row.data));
  for (const row of db.prepare("SELECT reference_id FROM grid_reference_images").iterate() as Iterable<{reference_id: string}>)
    referenceIds.add(row.reference_id);
  const copyReference = db.prepare("INSERT OR IGNORE INTO reference_images SELECT * FROM snapshot.reference_images WHERE id=?");
  for (const id of referenceIds) copyReference.run(id);
  db.exec("INSERT INTO reference_blobs SELECT * FROM snapshot.reference_blobs WHERE sha256 IN (SELECT sha256 FROM reference_images)");
  db.exec("DETACH DATABASE snapshot");
  db.transaction(() => {
    const outputs = new MigrationOutputFiles(files, input.sourceOutputs);
    migrateGridData(db, outputs, input.version);
    const imageOutputs = new Set<string>();
    const rows = db.prepare("SELECT id,artifact_id,data FROM workflow_tasks WHERE kind='generation'")
      .iterate() as Iterable<{id: string; artifact_id: string | null; data: string}>;
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (data.input.format !== "chat-template" || !row.artifact_id) continue;
      const path = outputs.path(row.artifact_id, "messages.json");
      if (!path) throw new Error(`Historical chat artifact for task ${row.id} is unavailable`);
      if (readChatOutput(readFileSync(path, "utf8")).some((message) => message.images?.length))
        imageOutputs.add(row.id);
    }
    migrateChatExecutionPlans(db, input.models, imageOutputs);
  })();
} catch (error) {
  if (!(error instanceof InvalidHistoricalChat) || input.gridId !== "9f400f3b9e10187aac5bb688b26cacdb323882837d900b1c") throw error;
  db.close();
  source.close();
  parentPort!.postMessage({ database, files, gridId: input.gridId, drop: true });
}
if (db.open) {
  db.close();
  source.close();
  parentPort!.postMessage({ database, files, gridId: input.gridId, drop: false });
}
