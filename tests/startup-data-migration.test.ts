import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runtimeConfig } from "../server/runtime-config.js";
import { Store } from "../server/store.js";
import {
  migrationDestinations,
  type ChatOutputMigrationFixture,
} from "./chat-output-migration-fixture.js";
import {
  addHistoricalTextPolicyGrid,
  expectedStartupMessages,
  outputFileInventory,
  startupConfigFixture,
  startupMigrationDatabaseState,
  startupMigrationFixture,
  startupMigrationModels,
  storedChatTasks,
  storedTextPolicy,
} from "./startup-data-migration-fixture.js";

async function openStore(
  t: TestContext,
  fixture: ChatOutputMigrationFixture,
  models = startupMigrationModels,
) {
  const store = await Store.open(fixture.database, fixture.secret, fixture.outputs, {
    models: async () => models,
  });
  t.after(() => {
    if (store.db.open) store.db.close();
  });
  return store;
}

async function assertCanonicalOutputs(store: Store) {
  const artifacts: string[] = [];
  for (const destination of migrationDestinations) {
    const grid = store.get(destination)!;
    assert.equal(grid.cells[0].status, "complete");
    const download = store.outputDownload(`cell-${destination}`)!;
    assert.ok(download.artifactId);
    assert.equal(download.artifactId, grid.cells[0].artifactId);
    const bundle = await store.files.bundle(download.artifactId);
    assert.deepEqual(Object.keys(bundle), ["messages.json"]);
    assert.deepEqual(
      JSON.parse(Buffer.from(bundle["messages.json"]).toString("utf8")),
      expectedStartupMessages(destination),
    );
    artifacts.push(download.artifactId);
  }
  assert.notEqual(artifacts[0], artifacts[1]);
  return artifacts;
}

test("a later grid's missing historical image leaves all source metadata and authoritative outputs untouched", async (t) => {
  const fixture = startupMigrationFixture(t);
  fixture.removeRequiredLateImage();
  const before = startupMigrationDatabaseState(fixture.database);
  const inventory = outputFileInventory(fixture.outputs);
  assert.equal(before.version, 19);
  assert.deepEqual(before.foreignKeyViolations, []);

  await assert.rejects(() => openStore(t, fixture));

  assert.deepEqual(
    startupMigrationDatabaseState(fixture.database),
    before,
    "the original logical database and version remain authoritative until every grid succeeds",
  );
  assert.deepEqual(
    outputFileInventory(fixture.outputs),
    inventory,
    "a successfully converted earlier grid must not install canonical files before later workers succeed",
  );
});

test("successful multi-grid startup publishes canonical output for each grid and preserves unrelated storage", async (t) => {
  const fixture = startupMigrationFixture(t);
  const before = startupMigrationDatabaseState(fixture.database);
  const originalTasks = storedChatTasks(fixture.database);
  const inventory = outputFileInventory(fixture.outputs);
  runtimeConfig();
  const store = await openStore(t, fixture);

  await assertCanonicalOutputs(store);
  const after = startupMigrationDatabaseState(fixture.database);
  assert.ok(after.version > before.version);
  assert.deepEqual(after.foreignKeyViolations, []);
  for (const table of Object.keys(before.tables)) {
    if (table === "grids" || table === "workflow_tasks") continue;
    assert.deepEqual(after.tables[table], before.tables[table], `${table} is preserved`);
  }
  for (const task of storedChatTasks(fixture.database)) {
    const original = originalTasks.find(({ id }) => id === task.id)!;
    assert.equal(task.status, original.status);
    assert.equal(task.thinking_source_id, original.thinking_source_id);
    assert.deepEqual(task.data.output, original.data.output);
    assert.equal(task.data.attemptId, original.data.attemptId);
    assert.equal(task.data.error, original.data.error);
  }
  const afterInventory = outputFileInventory(fixture.outputs);
  for (const file of inventory)
    assert.deepEqual(
      afterInventory.find(({ path }) => path === file.path),
      file,
      `publication must retain historical file ${file.path}`,
    );
  assert.equal(store.session("browser-session")!.key, "preserved-browser-key");
  assert.equal(store.get("source")!.published, true);
  const markdown = store.outputDownload("cell-markdown")!;
  assert.equal(markdown.artifactId, "markdown-artifact");
  assert.equal(
    Buffer.from((await store.files.bundle(markdown.artifactId))["index.md"]).toString(),
    "Unrelated Markdown stays byte-for-byte intact.\n",
  );
});

test("repeated failed startups can retry after image restoration and a subsequent restart changes neither records nor files", async (t) => {
  const fixture = startupMigrationFixture(t);
  const restore = fixture.removeRequiredLateImage();
  const before = startupMigrationDatabaseState(fixture.database);
  const inventory = outputFileInventory(fixture.outputs);

  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => openStore(t, fixture));
    assert.deepEqual(startupMigrationDatabaseState(fixture.database), before);
    assert.deepEqual(outputFileInventory(fixture.outputs), inventory);
  }

  restore();
  const first = await openStore(t, fixture);
  const artifacts = await assertCanonicalOutputs(first);
  const published = startupMigrationDatabaseState(fixture.database);
  const publishedFiles = outputFileInventory(fixture.outputs);
  assert.ok(published.version > before.version);
  assert.deepEqual(published.foreignKeyViolations, []);
  first.db.close();

  const restarted = await openStore(t, fixture);
  assert.deepEqual(await assertCanonicalOutputs(restarted), artifacts);
  assert.deepEqual(startupMigrationDatabaseState(fixture.database), published);
  assert.deepEqual(outputFileInventory(fixture.outputs), publishedFiles);
});

test("historical mixed-output generation with a text-only judge migrates to durable text output without altering accepted work", async (t) => {
  const fixture = startupMigrationFixture(t);
  addHistoricalTextPolicyGrid(fixture);
  const before = storedTextPolicy(fixture.database);
  const inventory = outputFileInventory(fixture.outputs);
  const store = await openStore(t, fixture);
  const after = storedTextPolicy(fixture.database);

  for (const parameter of ["input", "model", "judge_model"])
    assert.deepEqual(
      after.grid.input.parameters[parameter],
      before.grid.input.parameters[parameter],
    );
  const generation = after.tasks.find((task) => task.id === "task-text-policy")!;
  const original = before.tasks.find((task) => task.id === generation.id)!;
  assert.deepEqual(generation, {
    ...original,
    data: {
      ...original.data,
      input: { ...original.data.input, chatOutputMode: "text" },
    },
  });
  const runtime = store.get("text-policy")!;
  assert.equal(runtime.status, "paused");
  assert.equal(runtime.cells[0].status, "pending");
  assert.equal(runtime.cells[0].artifactId, undefined);
  assert.deepEqual(
    outputFileInventory(fixture.outputs).filter(({ path }) =>
      inventory.some((original) => original.path === path),
    ),
    inventory,
  );

  const state = startupMigrationDatabaseState(fixture.database);
  const files = outputFileInventory(fixture.outputs);
  store.db.close();
  const restarted = await openStore(t, fixture);
  assert.deepEqual(restarted.get("text-policy")!.input, after.grid.input);
  assert.deepEqual(startupMigrationDatabaseState(fixture.database), state);
  assert.deepEqual(outputFileInventory(fixture.outputs), files);
});

for (const workers of [undefined, "0", "1.5", "Infinity", "30workers"]) {
  test(`startup configuration rejects ${workers === undefined ? "missing" : JSON.stringify(workers)} migration worker capacity instead of silently defaulting`, (t) => {
    startupConfigFixture(t, workers);
    assert.throws(runtimeConfig, /STARTUP_DATA_MIGRATION_PARALLEL_WORKERS/);
  });
}

test("compatible historical image policy survives restart without consulting unavailable catalog metadata", async (t) => {
  const fixture = startupMigrationFixture(t);
  addHistoricalTextPolicyGrid(fixture);
  const models = startupMigrationModels.map((model) =>
    model.id === "historical/text-judge" ? { ...model, imageInput: true } : model,
  );
  const store = await openStore(t, fixture, models);
  const task = store.workflow("text-policy").find((entry) => entry.kind === "generation");
  assert.ok(task?.kind === "generation" && task.input.format === "chat-template");
  assert.equal(task.input.chatOutputMode, "text-and-images");
  store.db.close();
  const restarted = await Store.open(fixture.database, fixture.secret, fixture.outputs, {
    models: async () => { throw new Error("Catalog metadata is unavailable"); },
  });
  t.after(() => { if (restarted.db.open) restarted.db.close(); });
  const persisted = restarted.workflow("text-policy").find((entry) => entry.kind === "generation");
  assert.deepEqual(persisted?.input, task.input);
});
