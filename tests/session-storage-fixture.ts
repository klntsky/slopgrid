import type Database from "better-sqlite3";

export function storedSessionIds(db: Database.Database) {
  return db.prepare("SELECT id FROM sessions").all() as { id: string }[];
}

export function storedSessionPayloads(db: Database.Database) {
  return db.prepare("SELECT id, data FROM sessions").all() as {
    id: string;
    data: string;
  }[];
}

export function firstStoredSessionPayload(db: Database.Database) {
  return db.prepare("SELECT data FROM sessions").get() as { data: string };
}

export function hasGithubIdentity(db: Database.Database, subject: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM oauth_identities WHERE provider='github' AND subject=?",
    )
    .get(subject);
}
