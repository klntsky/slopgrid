export function referenceImages(db) {
  return db.prepare("SELECT * FROM reference_images").all();
}
export function orderedReferenceImages(db) {
  return db.prepare("SELECT * FROM reference_images ORDER BY id").all();
}
export function referenceImage(db, id = "reference-image") {
  return db.prepare("SELECT * FROM reference_images WHERE id=?").get(id);
}
export function referenceLinks(db) {
  return db.prepare("SELECT * FROM grid_reference_images").all();
}
export function orderedReferenceLinks(db) {
  return db
    .prepare(
      "SELECT grid_id,reference_id FROM grid_reference_images ORDER BY grid_id",
    )
    .all();
}
export function gridReferenceImages(db, gridId) {
  return db
    .prepare(
      `SELECT r.* FROM grid_reference_images g
    JOIN reference_images r ON r.id=g.reference_id WHERE g.grid_id=? ORDER BY r.id`,
    )
    .all(gridId);
}
export function referenceBlobs(db) {
  return db.prepare("SELECT * FROM reference_blobs").all();
}
export function seedReferenceBlob(db, sha256, width = null, height = null) {
  db.prepare(
    "INSERT INTO reference_blobs (sha256,width,height) VALUES (?,?,?)",
  ).run(sha256, width, height);
}
export function setReferenceBlobDimensions(db, sha256, width, height) {
  db.prepare("UPDATE reference_blobs SET width=?,height=? WHERE sha256=?").run(
    width,
    height,
    sha256,
  );
}
export function seedReferenceImage(
  db,
  id,
  owner,
  ownerUserId,
  name,
  mediaType,
  sha256 = null,
) {
  db.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?,?)").run(
    id,
    owner,
    ownerUserId,
    name,
    mediaType,
    sha256,
  );
}
export function seedReferenceLink(db, gridId, referenceId = "reference-image") {
  db.prepare("INSERT INTO grid_reference_images VALUES (?,?)").run(
    gridId,
    referenceId,
  );
}
export function seedSurvivingReferenceGrid(db, gridId) {
  db.prepare("INSERT INTO grids (id,data) VALUES (?,'{}')").run(gridId);
}
export function clearReferenceHash(db) {
  db.prepare("UPDATE reference_images SET sha256=NULL").run();
}
export function removeReferenceMetadata(db) {
  db.prepare("DELETE FROM reference_images").run();
}
export function rejectUploadTransfer(db, failure) {
  db.exec(
    failure === "target"
      ? "CREATE TRIGGER reject BEFORE INSERT ON cells BEGIN SELECT RAISE(ABORT,'controlled upload failure'); END"
      : "CREATE TRIGGER reject BEFORE DELETE ON grids BEGIN SELECT RAISE(ABORT,'controlled upload failure'); END",
  );
}
export function transferredGridExists(db, gridId) {
  return Boolean(db.prepare("SELECT 1 FROM grids WHERE id=?").get(gridId));
}
export function transferGridCount(db) {
  return db.prepare("SELECT count(*) n FROM grids").get().n;
}
export function transferCellCount(db) {
  return db.prepare("SELECT count(*) n FROM cells").get().n;
}

export function referenceForeignKeyViolations(db) {
  return db.pragma("foreign_key_check");
}

export function setReferenceSchemaVersion(db, version) {
  db.pragma(`user_version=${version}`);
}
