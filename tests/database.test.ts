import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Billing } from "../server/billing.js";
import { initializeDatabase } from "../server/database.js";
import { expandGrid, gridDraftSchema } from "../server/domain.js";
import { migrateProductionInput } from "../server/production-input-migration.js";
import * as migration from "./database-migration-fixture.js";
import {
  insertReferenceBlobDimensions,
  referenceBlobs,
} from "./reference-storage-fixture.js";

const { productionDatabase, seedProduction, snapshot, storedData, input } =
  migration;

test("production v14 migrates directly to canonical persisted inputs without rewriting accepted work or accounting", () => {
  const db = productionDatabase();
  try {
    seedProduction(db);
    const identities = migration.gridIdentitiesAndMetadata(db);
    const records = migration.unchangedProductionRecords(db);
    const references = migration.migratedReferenceImages(db);
    // The current Billing UI intentionally reads canonical inputs only. Capture
    // production accounting through its frozen SQL fixture before migration.
    const accounting = migration.productionBillingSummary(db);
    const acceptedData = storedData(db, "grid");
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.deepEqual(migration.gridIdentitiesAndMetadata(db), identities);
    assert.deepEqual(migration.unchangedProductionRecords(db), records);
    assert.deepEqual(
      migration.migratedReferenceImages(db),
      references.map((reference) => ({ ...reference, sha256: null })),
    );
    const { calls, ...summary } = new Billing(db).page(
      "anonymous",
      0,
      "account",
    );
    assert.deepEqual(summary, accounting);
    assert.deepEqual(
      calls.map(({ id, model, effort }) => ({ id, model, effort })),
      [
        { id: "unknown", model: "judge", effort: "high" },
        { id: "paid", model: "generator", effort: "none" },
        { id: "free", model: "generator", effort: "none" },
      ],
    );
    assert.deepEqual(new Billing(db).task("g:cell", "attempt")?.usage, {
      costUsd: 0.25,
      inputTokens: 15,
      outputTokens: 20,
    });
    assert.deepEqual(storedData(db, "grid"), {
      ...acceptedData,
      input: migrateProductionInput(input),
    });
    assert.equal(
      storedData(db, "private-grid").expanded_prompt_for_title,
      "Already expanded",
    );
    const canonical = storedData(db, "grid").input;
    assert.equal(canonical.inputVersion, 3);
    assert.equal(
      gridDraftSchema.safeParse({
        ...canonical,
        budgetUsd: String(canonical.budgetUsd),
      }).success,
      true,
    );
    assert.equal(expandGrid(canonical)[0].prompt, "Hello world");
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});

test("production v14 migration preserves row-major cell identities and both variable axes", () => {
  const db = productionDatabase();
  try {
    seedProduction(db);
    const source = {
      ...input,
      format: "markdown",
      prompt: "$ROW1 / $COLUMN2",
      rows: { kind: "variable", values: ["shape", "other"] },
      columns: { kind: "variable", values: ["red", "blue"] },
    };
    migration.replaceLegacyGridInputs(db, source);
    const before = migration.unchangedProductionRecords(db);
    initializeDatabase(db);
    const canonical = storedData(db, "grid").input;
    assert.deepEqual(canonical, migrateProductionInput(source));
    assert.deepEqual(
      expandGrid(canonical).map(({ row, column, prompt }) => ({
        row,
        column,
        prompt,
      })),
      [
        { row: 0, column: 0, prompt: "shape1 / red2" },
        { row: 0, column: 1, prompt: "shape1 / blue2" },
        { row: 1, column: 0, prompt: "other1 / red2" },
        { row: 1, column: 1, prompt: "other1 / blue2" },
      ],
    );
    assert.equal(
      new Set(canonical.rows.map((row: { id: string }) => row.id)).size,
      2,
    );
    assert.equal(
      new Set(canonical.columns.map((column: { id: string }) => column.id))
        .size,
      2,
    );
    assert.deepEqual(migration.unchangedProductionRecords(db), before);
  } finally {
    db.close();
  }
});

test("a failed direct v14 migration rolls back schema, every payload, indexes and version atomically", () => {
  const db = productionDatabase();
  try {
    seedProduction(db);
    const unblock = migration.rejectProductionInputMigration(db);
    const before = snapshot(db);
    assert.throws(
      () => initializeDatabase(db),
      /production input migration blocked/,
    );
    assert.deepEqual(snapshot(db), before);
    unblock();
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.equal(storedData(db, "grid").input.inputVersion, 3);
  } finally {
    db.close();
  }
});

test("invalid production JSON shapes roll back the direct migration without catalog-dependent admission", () => {
  const db = productionDatabase();
  try {
    seedProduction(db);
    migration.replaceLegacyGridInputs(
      db,
      { ...input, rows: { kind: "variable", values: [42] } },
      "grid",
    );
    const before = snapshot(db);
    assert.throws(
      () => initializeDatabase(db),
      /Cannot migrate production input for grid grid/,
    );
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("direct migration backfills configured links without deleting accepted or historical reference links", () => {
  const db = productionDatabase();
  try {
    seedProduction(db);
    migration.unlinkConfiguredReference(db);
    initializeDatabase(db);
    assert.deepEqual(migration.migratedGridReferenceIds(db), [
      { reference_id: "missing-reference" },
      { reference_id: "reference" },
      { reference_id: "unused-reference" },
    ]);
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
  } finally {
    db.close();
  }
});

test("unsupported pre-production and intermediate versions leave stored data untouched", () => {
  for (const version of [1, 7, 8, 9, 10, 11, 12, 13, 15, 16, 18]) {
    const db = productionDatabase();
    try {
      seedProduction(db);
      migration.setDatabaseVersion(db, version);
      const before = snapshot(db);
      assert.throws(
        () => initializeDatabase(db),
        /Unsupported database version/,
      );
      assert.deepEqual(snapshot(db), before);
    } finally {
      db.close();
    }
  }
});

test("fresh databases initialize once and preserve encrypted sessions", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    migration.seedEncryptedMigrationSession(db);
    const before = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("fresh and direct production upgrades enforce publication, slug uniqueness and grid cleanup", () => {
  for (const production of [false, true]) {
    const db = production ? productionDatabase() : new Database(":memory:");
    try {
      if (production) seedProduction(db);
      initializeDatabase(db);
      migration.insertPublicationBoundaryGrid(
        db,
        "constraint-grid",
        1,
        "public",
        "unique-public-slug",
      );
      assert.throws(
        () =>
          migration.insertPublicationBoundaryGrid(
            db,
            "duplicate",
            1,
            "public",
            "unique-public-slug",
          ),
        /UNIQUE constraint failed/,
      );
      assert.throws(
        () =>
          migration.insertPublicationBoundaryGrid(db, "invalid", 2, "public"),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => migration.insertBoundaryCell(db, "orphan", "missing"),
        /FOREIGN KEY constraint failed/,
      );
      migration.insertBoundaryCell(db, "constraint-cell", "constraint-grid");
      migration.seedBoundaryGridDependents(db);
      migration.removeBoundaryGrid(db);
      for (const dependents of migration.boundaryGridDependents(db))
        assert.deepEqual(dependents, []);
      assert.deepEqual(migration.foreignKeyViolations(db), []);
    } finally {
      db.close();
    }
  }
});

test("fresh and direct production upgrades enforce paired positive integer reference proportions", () => {
  for (const production of [false, true]) {
    const db = production ? productionDatabase() : new Database(":memory:");
    try {
      if (production) seedProduction(db);
      initializeDatabase(db);
      assert.deepEqual(referenceBlobs(db), []);
      insertReferenceBlobDimensions(db, "a".repeat(64), null, null);
      insertReferenceBlobDimensions(db, "b".repeat(64), 3, 7);
      for (const [width, height] of [
        [null, 3],
        [7, null],
        [0, 3],
        [-1, 3],
        [7, 0],
        [7, -1],
        [1.5, 3],
        [7, 2.5],
      ] as const)
        assert.throws(
          () =>
            insertReferenceBlobDimensions(db, "c".repeat(64), width, height),
          /CHECK constraint failed|cannot store REAL value/,
        );
      assert.deepEqual(referenceBlobs(db), [
        { sha256: "a".repeat(64), width: null, height: null },
        { sha256: "b".repeat(64), width: 3, height: 7 },
      ]);
      const stable = snapshot(db);
      initializeDatabase(db);
      assert.deepEqual(snapshot(db), stable);
    } finally {
      db.close();
    }
  }
});
