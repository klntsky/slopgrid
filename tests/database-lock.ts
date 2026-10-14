import type { Store } from "../server/store.js";

export function holdDatabaseWrites(store: Store) {
  store.db.exec("BEGIN IMMEDIATE");
  let held = true;
  return () => {
    if (held) {
      store.db.exec("ROLLBACK");
      held = false;
    }
  };
}
export function rejectAdmissionCommit(store: Store) {
  store.db.exec(`
    CREATE TABLE fault_parent(id TEXT PRIMARY KEY);
    CREATE TABLE fault_child(parent TEXT REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fault_admission AFTER UPDATE OF data ON grids
    WHEN json_extract(NEW.data, '$.status') = 'running'
    BEGIN INSERT INTO fault_child VALUES ('missing'); END;
  `);
  return () =>
    store.db.exec(
      "DROP TRIGGER fault_admission; DROP TABLE fault_child; DROP TABLE fault_parent",
    );
}
