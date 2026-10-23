import { chmodSync, constants, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { blankTestDatabase } from "./fixture-resources.js";

/** Copy a closed snapshot or blank migrated template into a private database. */
export function seedTestDatabase(database: string) {
  const snapshot = process.env.SLOPGRID_TEST_DATABASE;
  const source = snapshot || blankTestDatabase();
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  copyFileSync(
    source,
    database,
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
  if (!snapshot) chmodSync(database, 0o600);
}
