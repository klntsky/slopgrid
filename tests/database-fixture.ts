import { constants, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Seed an isolated service database from the closed, migrated validation snapshot. */
export function seedTestDatabase(database: string) {
  const source = process.env.SLOPGRID_TEST_DATABASE;
  if (!source) return;
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  copyFileSync(
    source,
    database,
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
}
