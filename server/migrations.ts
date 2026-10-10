import type Database from "better-sqlite3";

export type Migration = { version: number; sql: string };
const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE cells (
        id TEXT PRIMARY KEY,
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (grid_id, position)
      ) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
    `,
  },
];

export function migrate(
  db: Database.Database,
  steps: readonly Migration[] = migrations,
) {
  let previous = 0;
  for (const step of steps) {
    if (
      !Number.isSafeInteger(step.version) ||
      step.version <= previous ||
      step.version > 2147483647
    )
      throw new Error(
        "Migration versions must be positive, strictly increasing SQLite integers",
      );
    previous = step.version;
  }
  const current = db.pragma("user_version", { simple: true }) as number;
  if (
    current > previous ||
    (current !== 0 && !steps.some((step) => step.version === current))
  )
    throw new Error(
      "Database version is newer than or unsupported by this application",
    );
  for (const step of steps) {
    if (step.version <= current) continue;
    db.transaction(() => {
      db.exec(step.sql);
      db.pragma(`user_version = ${step.version}`);
    }).immediate();
  }
}
