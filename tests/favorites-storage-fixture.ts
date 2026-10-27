import type Database from "better-sqlite3";
import { expandGrid, type Grid } from "../server/domain.js";
import { token } from "../server/ids.js";
import type { Store } from "../server/store.js";
import { createWorkflow } from "../server/workflow.js";
import { fixtureModels, currentInput } from "./current-grid-fixture.js";
import { validatedGrid } from "./grid-storage-fixture.js";
import { productionV17Database } from "./database-migration-fixture.js";

export function favoriteAccounts(store: Store) {
  const aliceSubject = `favorites-alice-${token()}`;
  const alice = store.identify("github", aliceSubject, {
    provider: "github",
    username: "favorite-alice",
    profileURL: "https://github.com/favorite-alice",
  });
  const bob = store.identify("github", `favorites-bob-${token()}`, {
    provider: "github",
    username: "favorite-bob",
    profileURL: "https://github.com/favorite-bob",
  });
  const lineage = token();
  const sessions = {
    alice: token(),
    secondAlice: token(),
    bob: token(),
    anonymous: lineage,
    connectedAnonymous: token(),
  };
  for (const id of [sessions.alice, sessions.secondAlice])
    store.saveSession({
      id,
      userId: alice.id,
      anonymousId: lineage,
      created: Date.now(),
    });
  store.saveSession({
    id: sessions.bob,
    userId: bob.id,
    anonymousId: lineage,
    created: Date.now(),
  });
  store.saveSession({ id: lineage, created: Date.now() });
  store.saveSession({
    id: sessions.connectedAnonymous,
    key: "openrouter-is-not-an-account",
    created: Date.now(),
  });
  return { alice, bob, aliceSubject, lineage, sessions };
}

export function favoriteGrid(
  store: Store,
  options: Pick<Grid, "owner"> &
    Partial<
      Pick<
        Grid,
        | "ownerUserId"
        | "published"
        | "visibility"
        | "author"
        | "slug"
        | "title"
        | "createdAt"
        | "status"
      >
    >,
) {
  const id = token();
  const input = currentInput();
  const grid: Grid = {
    id,
    input,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "paused",
    published: false,
    visibility: "private",
    ...options,
    cells: expandGrid(input).map((cell) => ({ ...cell, id: `${id}-cell` })),
  };
  const tasks = createWorkflow(input, grid.cells, fixtureModels);
  for (const task of tasks) {
    task.status = "error";
    task.error = "Favorite fixture has no generation work";
  }
  store.insert(validatedGrid(grid), tasks);
  return grid;
}

export function storedFavoriteIds(db: Database.Database, userId: string) {
  return db
    .prepare<[string], { grid_id: string }>(
      "SELECT grid_id FROM grid_favorites WHERE user_id=? ORDER BY grid_id",
    )
    .all(userId)
    .map(({ grid_id }) => grid_id);
}

export function storedAnonymousFavoriteIds(
  db: Database.Database,
  anonymousId: string,
) {
  return db
    .prepare<[string], { grid_id: string }>(
      "SELECT grid_id FROM anonymous_grid_favorites WHERE anonymous_id=? ORDER BY grid_id",
    )
    .all(anonymousId)
    .map(({ grid_id }) => grid_id);
}

export function insertFavoriteMembership(
  db: Database.Database,
  userId: string,
  gridId: string,
) {
  db.prepare("INSERT INTO grid_favorites (user_id,grid_id) VALUES (?,?)").run(
    userId,
    gridId,
  );
}

export function insertAnonymousFavoriteMembership(
  db: Database.Database,
  anonymousId: string,
  gridId: string,
) {
  db.prepare(
    "INSERT INTO anonymous_grid_favorites (anonymous_id,grid_id) VALUES (?,?)",
  ).run(anonymousId, gridId);
}

export function favoriteClaimReference(db: Database.Database, owner: string) {
  const id = token();
  db.prepare(
    "INSERT INTO reference_images (id,owner,name,media_type) VALUES (?,?,?,?)",
  ).run(id, owner, "claim.png", "image/png");
  return id;
}

export function favoriteClaimReferenceOwner(
  db: Database.Database,
  referenceId: string,
) {
  return db
    .prepare<[string], { ownerUserId: string | null }>(
      "SELECT owner_user_id AS ownerUserId FROM reference_images WHERE id=?",
    )
    .get(referenceId)!.ownerUserId;
}

export function setFavoriteGridAccess(
  db: Database.Database,
  gridId: string,
  published: boolean,
  visibility: Grid["visibility"],
) {
  db.prepare("UPDATE grids SET published=?,visibility=? WHERE id=?").run(
    published ? 1 : 0,
    visibility,
    gridId,
  );
}

export function removeFavoriteGrid(db: Database.Database, gridId: string) {
  db.prepare("DELETE FROM grids WHERE id=?").run(gridId);
}

export function removeFavoriteAccount(db: Database.Database, userId: string) {
  db.prepare("DELETE FROM oauth_identities WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM users WHERE id=?").run(userId);
}

export function rejectFavoriteWrites(
  db: Database.Database,
  owner: "account" | "anonymous" = "account",
) {
  const table =
    owner === "account" ? "grid_favorites" : "anonymous_grid_favorites";
  db.exec(`CREATE TEMP TRIGGER reject_favorite_insert BEFORE INSERT ON ${table}
    BEGIN SELECT RAISE(ABORT,'favorite storage unavailable'); END;
    CREATE TEMP TRIGGER reject_favorite_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'favorite storage unavailable'); END;`);
  return () =>
    db.exec(`DROP TRIGGER reject_favorite_insert;
    DROP TRIGGER reject_favorite_delete;`);
}

export function obstructFavoritesMigration(db: Database.Database) {
  db.exec("CREATE TABLE grid_favorites (legacy TEXT) STRICT");
}

export function obstructAnonymousFavoritesMigration(db: Database.Database) {
  db.exec("CREATE TABLE anonymous_grid_favorites (legacy TEXT) STRICT");
}

export function productionV18Database() {
  const db = productionV17Database();
  db.exec(`
    CREATE TABLE grid_favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id,grid_id)
    ) STRICT;
    CREATE INDEX grid_favorites_grid ON grid_favorites(grid_id);
  `);
  db.pragma("user_version = 18");
  return db;
}

export function insertFavoriteAccount(db: Database.Database, userId: string) {
  db.prepare("INSERT INTO users (id,data) VALUES (?,?)").run(
    userId,
    JSON.stringify({
      provider: "github",
      username: "migration-favorites",
      profileURL: "https://github.com/migration-favorites",
    }),
  );
}

export function favoriteMigrationPreservedState(db: Database.Database) {
  return preservedMigrationState(db, [
    "grid_favorites",
    "anonymous_grid_favorites",
  ]);
}

export function anonymousFavoriteMigrationPreservedState(
  db: Database.Database,
) {
  return preservedMigrationState(db, ["anonymous_grid_favorites"]);
}

function preservedMigrationState(
  db: Database.Database,
  excludedTables: string[],
) {
  const placeholders = excludedTables.map(() => "?").join(",");
  const tables = db
    .prepare<string[], { name: string }>(
      `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN (${placeholders}) ORDER BY name`,
    )
    .all(...excludedTables);
  return {
    schema: db
      .prepare(
        `SELECT type,name,sql FROM sqlite_schema WHERE tbl_name NOT IN (${placeholders}) ORDER BY type,name`,
      )
      .all(...excludedTables),
    rows: tables.map(({ name }) => [
      name,
      db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all(),
    ]),
  };
}
