import type Database from "better-sqlite3";

export function rejectCreationReceipts(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON creation_requests BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
  );
  return () => db.exec("DROP TRIGGER reject_receipt");
}

export function storedOwnerCreationReceipts(
  db: Database.Database,
  owner: string,
) {
  return db.prepare("SELECT * FROM creation_requests WHERE owner=?").all(owner);
}

export function moveCreatedGridToAnotherAccount(
  db: Database.Database,
  gridId: string,
) {
  db.prepare("UPDATE grids SET owner_user_id='another-account' WHERE id=?").run(
    gridId,
  );
}
