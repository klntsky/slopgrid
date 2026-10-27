import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { copyProductionData } from "../lib/staging-data.mjs";
import {
  artifactBytes, productionKey, productionSession, stagingDataFixture,
  stagingKey, storageTree,
} from "./staging-data-fixture.mjs";

function copy(f, stagingEnv = f.stagingEnv) {
  return copyProductionData(f.target, f.release, stagingEnv, f.productionEnv, f.run);
}

function withoutEncryptionAssignment(text) {
  return text.split("\n").filter((line) => !/^KEY_ENCRYPTION_SECRET=/.test(line)).join("\n");
}

test("production copy snapshots live WAL records, replaces staging outputs including hidden files, and adopts only the production encryption key", async (t) => {
  const f = stagingDataFixture(t, { wal: true, sidecars: true });
  const sourceBefore = f.sourceState();
  const originalStagingEnv = { ...f.stagingEnv };
  const originalProductionEnv = { ...f.productionEnv };
  const expectedOutputs = storageTree(f.productionEnv.OUTPUTS_PATH);

  const updated = await copy(f);

  assert.deepEqual(updated, { ...originalStagingEnv, KEY_ENCRYPTION_SECRET: productionKey });
  assert.deepEqual(f.stagingEnv, originalStagingEnv);
  assert.deepEqual(f.productionEnv, originalProductionEnv);
  assert.deepEqual(f.sourceState(), sourceBefore);
  assert.deepEqual(storageTree(updated.OUTPUTS_PATH), expectedOutputs);
  assert.equal(existsSync(join(updated.OUTPUTS_PATH, "staging-only.txt")), false);
  for (const suffix of ["-wal", "-shm", "-journal"])
    assert.equal(existsSync(updated.DATABASE_PATH + suffix), false, `old ${suffix} must not survive installation`);

  const persisted = readFileSync(f.target.envFile, "utf8");
  assert.deepEqual(parseEnv(persisted), updated);
  assert.equal(withoutEncryptionAssignment(persisted), withoutEncryptionAssignment(f.stagingEnvText));
  assert.doesNotMatch(persisted, /private-production-oauth-secret|production-client|PRODUCTION_ONLY/);
  const state = f.inspect(updated);
  assert.deepEqual(state.sessions, [productionSession, { ...productionSession, id: "wal-session" }]);
  assert.deepEqual(state.grids.map(({ id, status, interruption }) => ({ id, status, interruption })), [
    { id: "production-grid", status: "paused", interruption: "restart" },
  ]);
  assert.equal(state.version, state.schemaVersion);
  assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
  assert.deepEqual(state.foreignKeys, []);
  assert.throws(() => f.inspect({ ...updated, KEY_ENCRYPTION_SECRET: stagingKey }));

  for (const [staged, original] of [
    [updated.DATABASE_PATH, f.productionEnv.DATABASE_PATH],
    [join(updated.OUTPUTS_PATH, "nested/artifact.bin"), join(f.productionEnv.OUTPUTS_PATH, "nested/artifact.bin")],
    [join(updated.OUTPUTS_PATH, ".references/upload"), join(f.productionEnv.OUTPUTS_PATH, ".references/upload")],
  ]) assert.notEqual(`${statSync(staged).dev}:${statSync(staged).ino}`, `${statSync(original).dev}:${statSync(original).ino}`);
  writeFileSync(join(updated.OUTPUTS_PATH, "nested/artifact.bin"), "staging-only change");
  assert.deepEqual(readFileSync(join(f.productionEnv.OUTPUTS_PATH, "nested/artifact.bin")), artifactBytes);
  assert.deepEqual(f.sourceState(), sourceBefore);
});

test("production copy migrates historical application storage and recovers interrupted work only in staging", async (t) => {
  const f = stagingDataFixture(t, { legacy: true });
  const sourceBefore = f.sourceState();

  const updated = await copy(f);
  const state = f.inspect(updated);

  assert.equal(state.version, state.schemaVersion);
  assert.equal(state.sessions.find(({ id }) => id === "session").key, "production-browser-key");
  assert.deepEqual(state.grids.map(({ id }) => id).sort(), ["grid", "private-grid"]);
  assert.equal(state.grids.find(({ id }) => id === "grid").interruption, "restart");
  assert.equal(state.tasks.find(({ id }) => id === "accepted-judge").status, "pending");
  assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
  assert.deepEqual(state.foreignKeys, []);
  assert.deepEqual(f.sourceState(), sourceBefore);
});

test("production copy rejects missing or invalid target migration capacity without changing storage", async (t) => {
  const f = stagingDataFixture(t);
  const stagingBefore = f.stagingState(), sourceBefore = f.sourceState();
  for (const value of [undefined, "", "0", "-1", "1.5", "9007199254740992"]) {
    const stagingEnv = { ...f.stagingEnv };
    if (value === undefined) delete stagingEnv.STARTUP_DATA_MIGRATION_PARALLEL_WORKERS;
    else stagingEnv.STARTUP_DATA_MIGRATION_PARALLEL_WORKERS = value;
    await assert.rejects(copy(f, stagingEnv),
      /STARTUP_DATA_MIGRATION_PARALLEL_WORKERS must be a positive safe integer/);
    assert.deepEqual(f.stagingState(), stagingBefore);
    assert.deepEqual(f.sourceState(), sourceBefore);
  }
});

for (const fault of ["invalid-database", "future-version", "wrong-key", "foreign-key", "migration-rejected"])
  test(`production copy rejects ${fault} before changing staging storage or environment`, async (t) => {
    const f = stagingDataFixture(t, { fault, legacy: fault === "migration-rejected", sidecars: true });
    const stagingBefore = f.stagingState();
    const sourceBefore = f.sourceState();

    await assert.rejects(copy(f));

    assert.deepEqual(f.stagingState(), stagingBefore);
    assert.deepEqual(f.sourceState(), sourceBefore);
  });

for (const [name, destination] of [
  ["same database", (f) => ({ DATABASE_PATH: f.productionEnv.DATABASE_PATH })],
  ["same output tree", (f) => ({ OUTPUTS_PATH: f.productionEnv.OUTPUTS_PATH })],
  ["output tree nested inside production", (f) => ({ OUTPUTS_PATH: join(f.productionEnv.OUTPUTS_PATH, "staging") })],
  ["database inside production outputs", (f) => ({ DATABASE_PATH: join(f.productionEnv.OUTPUTS_PATH, "staging.sqlite") })],
]) test(`production copy rejects overlapping ${name}`, async (t) => {
  const f = stagingDataFixture(t);
  const stagingBefore = f.stagingState();
  const sourceBefore = f.sourceState();

  await assert.rejects(copy(f, { ...f.stagingEnv, ...destination(f) }));

  assert.deepEqual(f.stagingState(), stagingBefore);
  assert.deepEqual(f.sourceState(), sourceBefore);
});

for (const alias of ["symlink", "hardlink"])
  test(`production copy rejects a ${alias} destination database alias to production`, async (t) => {
    const f = stagingDataFixture(t);
    const aliasedDatabase = join(f.target.applicationRoot, "aliased.sqlite");
    if (alias === "symlink") symlinkSync(f.productionEnv.DATABASE_PATH, aliasedDatabase);
    else linkSync(f.productionEnv.DATABASE_PATH, aliasedDatabase);
    const stagingBefore = f.stagingState();
    const sourceBefore = f.sourceState();

    await assert.rejects(copy(f, { ...f.stagingEnv, DATABASE_PATH: aliasedDatabase }));

    assert.deepEqual(f.stagingState(), stagingBefore);
    assert.deepEqual(f.sourceState(), sourceBefore);
    assert.equal(existsSync(aliasedDatabase), true);
  });

test("production copy rejects linked output content shared between staging and production", async (t) => {
  const f = stagingDataFixture(t);
  linkSync(join(f.productionEnv.OUTPUTS_PATH, ".references/upload"), join(f.stagingEnv.OUTPUTS_PATH, "shared-upload"));
  const stagingBefore = f.stagingState();
  const sourceBefore = f.sourceState();

  await assert.rejects(copy(f));

  assert.deepEqual(f.stagingState(), stagingBefore);
  assert.deepEqual(f.sourceState(), sourceBefore);
});

test("production copy rejects symlinked hidden source output without touching its target or staging", async (t) => {
  const f = stagingDataFixture(t);
  symlinkSync(f.target.envFile, join(f.productionEnv.OUTPUTS_PATH, ".references/unsafe-link"));
  const stagingBefore = f.stagingState();
  const sourceBefore = f.sourceState();

  await assert.rejects(copy(f));

  assert.deepEqual(f.stagingState(), stagingBefore);
  assert.deepEqual(f.sourceState(), sourceBefore);
});
