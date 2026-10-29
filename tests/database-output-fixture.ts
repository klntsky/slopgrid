import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { OutputFiles } from "../server/files.js";

const outputs = new WeakMap<Database.Database, OutputFiles>();
const directories: string[] = [];

after(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

export function databaseOutputFiles(db: Database.Database) {
  let files = outputs.get(db);
  if (!files) {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-database-output-"));
    directories.push(directory);
    files = new OutputFiles(directory);
    outputs.set(db, files);
  }
  return files;
}
