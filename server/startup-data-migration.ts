import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync,
  openSync, readSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import type { Model } from "./provider.js";
import { initializeEmptyDatabase, schemaVersion, upgradeDatabaseStructure } from "./database.js";
import { migrateReferenceFiles } from "./chat-output-migration.js";
import { MigrationOutputFiles } from "./migration-output-files.js";
import { startupDataMigrationParallelWorkers } from "./runtime-config.js";
import { acquireStartupDatabaseLock } from "./startup-database-lock.js";

export type StoreOpenOptions = { models: () => Promise<readonly Model[]> };
type GridResult = { database: string; files: string; gridId: string; drop: boolean };

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncTree(path: string): void {
  if (statSync(path).isDirectory())
    for (const name of readdirSync(path)) syncTree(join(path, name));
  syncPath(path);
}
function identical(left: string, right: string): boolean {
  const a = statSync(left);
  const b = statSync(right);
  if (a.isDirectory() !== b.isDirectory() || a.isFile() !== b.isFile()) return false;
  if (a.isDirectory()) {
    const names = readdirSync(left).sort();
    const other = readdirSync(right).sort();
    return JSON.stringify(names) === JSON.stringify(other) && names.every((name) => identical(join(left, name), join(right, name)));
  }
  if (!a.isFile() || a.size !== b.size) return false;
  const fdA = openSync(left, "r");
  const fdB = openSync(right, "r");
  const chunkA = Buffer.allocUnsafe(64 * 1024);
  const chunkB = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (position < a.size) {
      const length = Math.min(chunkA.length, a.size - position);
      if (readSync(fdA, chunkA, 0, length, position) !== length || readSync(fdB, chunkB, 0, length, position) !== length || !chunkA.subarray(0, length).equals(chunkB.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally { closeSync(fdA); closeSync(fdB); }
}

function installFiles(source: string, destination: string, installed: string[], pendingPrefix: string): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    if (name === ".references") {
      installFiles(from, to, installed, pendingPrefix);
      continue;
    }
    if (existsSync(to)) {
      if (!identical(from, to)) throw new Error(`Migration output conflicts with existing immutable content: ${to}`);
      continue;
    }
    // Copy on the destination filesystem, then atomically install there.
    const pending = mkdtempSync(join(destination, pendingPrefix));
    try {
      const content = join(pending, "content");
      cpSync(from, content, { recursive: true, errorOnExist: true, force: false });
      syncTree(content);
      renameSync(content, to);
      installed.push(to);
      syncPath(destination);
    } finally { rmSync(pending, { recursive: true, force: true }); }
  }
}

async function migrateGrids(snapshot: string, directory: string, sourceOutputs: string, version: number, models: readonly Model[], capacity: number): Promise<GridResult[]> {
  const metadata = new Database(snapshot, { readonly: true });
  const ids = (metadata.prepare("SELECT id FROM grids ORDER BY rowid").all() as {id: string}[]).map((row) => row.id);
  metadata.close();
  const running = new Set<Worker>();
  const results: GridResult[] = [];
  let next = 0;
  let failure: unknown;
  const workerModule = fileURLToPath(new URL("./startup-data-migration-worker.ts", import.meta.url));
  const run = async () => {
    while (!failure && next < ids.length) {
      const index = next++;
      const gridId = ids[index];
      let worker: Worker | undefined;
      try {
        const active = new Worker(`require('tsx/cjs/api').register(); require(${JSON.stringify(workerModule)});`, {
          eval: true,
          execArgv: [],
          workerData: { snapshot, directory: join(directory, `grid-${index}`), sourceOutputs, gridId, version, models },
        });
        worker = active;
        running.add(active);
        const result = await new Promise<GridResult>((resolve, reject) => {
          let message: GridResult | undefined;
          active.once("message", (value: GridResult) => { message = value; });
          active.once("error", reject);
          active.once("exit", (code) => {
            if (code !== 0 || !message) reject(new Error(`Migration worker for grid ${gridId} exited without a result (${code})`));
            else resolve(message);
          });
        });
        results.push(result);
      } catch (error) {
        failure ??= error;
        await Promise.all([...running].map((active) => active.terminate()));
        throw error;
      } finally { if (worker) running.delete(worker); }
    }
  };
  const lanes = Array.from({ length: Math.min(capacity, ids.length) }, run);
  const settled = await Promise.allSettled(lanes);
  const rejected = settled.find((value) => value.status === "rejected");
  if (rejected?.status === "rejected") throw failure ?? rejected.reason;
  return results;
}

function mergeGrid(db: Database.Database, result: GridResult): void {
  if (result.drop) {
    // Foreign keys are disabled while publishing the private snapshot. Delete only
    // the authorized grid and its actual dependents, retaining shared references.
    db.transaction(() => {
      db.prepare("DELETE FROM inference_calls WHERE cell_id IN (SELECT id FROM cells WHERE grid_id=?) OR task_id IN (SELECT id FROM workflow_tasks WHERE grid_id=?)").run(result.gridId, result.gridId);
      for (const table of ["creation_requests", "grid_favorites", "anonymous_grid_favorites", "grid_reference_images", "cells", "workflow_tasks"])
        db.prepare(`DELETE FROM ${table} WHERE grid_id=?`).run(result.gridId);
      db.prepare("DELETE FROM grids WHERE id=?").run(result.gridId);
    })();
    return;
  }
  db.prepare("ATTACH DATABASE ? AS migrated").run(result.database);
  try {
    db.transaction(() => {
      db.exec(`
        UPDATE grids AS target SET data=source.data
          FROM migrated.grids AS source
          WHERE target.id=source.id AND target.data IS NOT source.data;
        UPDATE workflow_tasks AS target SET data=source.data,artifact_id=source.artifact_id
          FROM migrated.workflow_tasks AS source
          WHERE target.id=source.id
            AND (target.data IS NOT source.data OR target.artifact_id IS NOT source.artifact_id);
        INSERT INTO reference_blobs SELECT * FROM migrated.reference_blobs WHERE true
          ON CONFLICT(sha256) DO UPDATE SET width=coalesce(reference_blobs.width,excluded.width),height=coalesce(reference_blobs.height,excluded.height);
        UPDATE reference_images AS target SET sha256=source.sha256
          FROM migrated.reference_images AS source
          WHERE target.id=source.id AND target.sha256 IS NOT source.sha256;
        INSERT OR IGNORE INTO grid_reference_images SELECT * FROM migrated.grid_reference_images;
      `);
    })();
  } finally { db.exec("DETACH DATABASE migrated"); }
}

function readyDatabase(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function openStartupDatabase(path: string, outputsPath: string, options?: StoreOpenOptions): Promise<Database.Database> {
  if (path === ":memory:") {
    const db = readyDatabase(path);
    try { initializeEmptyDatabase(db); return db; }
    catch (error) { db.close(); throw error; }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireStartupDatabaseLock(path + ".startup.lock");
  let source: Database.Database | undefined;
  let staged: Database.Database | undefined;
  let directory: string | undefined;
  let published = false;
  const installed: string[] = [];
  try {
    const stagingPrefix = `.${basename(path)}.startup-migration-`;
    const installPrefix = `.${basename(path)}.migration-install-`;
    for (const root of [outputsPath, join(outputsPath, ".references")]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name.startsWith(installPrefix))
          rmSync(join(root, entry.name), { recursive: true, force: true });
    }
    for (const entry of readdirSync(dirname(path), { withFileTypes: true }))
      if (entry.isDirectory() && entry.name.startsWith(stagingPrefix))
        rmSync(join(dirname(path), entry.name), { recursive: true, force: true });
    source = new Database(path);
    const version = source.pragma("user_version", { simple: true }) as number;
    if (version === schemaVersion || version === 0) {
      if (version === 0) initializeEmptyDatabase(source);
      source.close();
      source = undefined;
      lock.assertHeld();
      return readyDatabase(path);
    }
    if (![14, 17, 18, 19, 20, 21].includes(version)) throw new Error(`Unsupported database version ${version}`);
    const capacity = startupDataMigrationParallelWorkers();
    directory = mkdtempSync(join(dirname(path), stagingPrefix));
    const snapshot = join(directory, "dataset.sqlite");
    await source.backup(snapshot);
    const checkpoint = source.pragma("wal_checkpoint(TRUNCATE)") as {busy: number}[];
    if (checkpoint.some((row) => row.busy !== 0)) throw new Error("Startup migration requires all prior database users to be stopped");
    source.close();
    source = undefined;
    staged = new Database(snapshot);
    staged.pragma("journal_mode = DELETE");
    staged.transaction(() => upgradeDatabaseStructure(staged!, version))();
    const hasChatTasks = staged.prepare(`
      SELECT 1 FROM workflow_tasks
      WHERE kind='generation' AND json_extract(data,'$.input.format')='chat-template'
      LIMIT 1
    `).get() !== undefined;
    if (hasChatTasks && !options?.models)
      throw new Error("Historical chat data migration requires one current model catalog snapshot");
    const models = hasChatTasks ? await options!.models() : [];
    const results = await migrateGrids(snapshot, directory, outputsPath, version, models, capacity);
    lock.assertHeld();
    for (const result of results) mergeGrid(staged, result);
    const referenceFiles = join(directory, "reference-files");
    migrateReferenceFiles(staged, new MigrationOutputFiles(referenceFiles, outputsPath));
    staged.pragma(`user_version = ${schemaVersion}`);
    const violations = staged.pragma("foreign_key_check") as unknown[];
    if (violations.length) throw new Error("Migrated database contains broken foreign key references");
    staged.pragma("wal_checkpoint(TRUNCATE)");
    staged.close();
    staged = undefined;
    syncPath(snapshot);
    for (const result of results) if (!result.drop) installFiles(result.files, outputsPath, installed, installPrefix);
    installFiles(referenceFiles, outputsPath, installed, installPrefix);
    syncPath(outputsPath);
    lock.assertHeld();
    renameSync(snapshot, path);
    published = true;
    syncPath(dirname(path));
    return readyDatabase(path);
  } catch (error) {
    if (!published) for (const file of installed.reverse()) rmSync(file, { recursive: true, force: true });
    throw error;
  } finally {
    source?.close();
    staged?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    await lock.release();
  }
}
