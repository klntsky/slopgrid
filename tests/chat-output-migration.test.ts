import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../server/store.js";
import { generatedDataUrl, generatedPng } from "./chat-image-output-fixture.js";
import {
  chatOutputMigrationFixture,
  chatMigrationDatabaseState,
  corruptInstalledChatReplacement,
  expectedMigratedMessages,
  failChatArtifactRepoint,
  killMigrationBeforeArtifactRepoint,
  migrationDestinations,
  outputFileInventory,
  storedChatTasks,
  type CanonicalMessageJSON,
  type ChatOutputMigrationFixture,
} from "./chat-output-migration-fixture.js";

function openStore(t: TestContext, fixture: ChatOutputMigrationFixture) {
  const store = new Store(fixture.database, fixture.secret, fixture.outputs);
  t.after(() => {
    if (store.db.open) store.db.close();
  });
  return store;
}

async function assertCanonicalSavedMessages(store: Store) {
  const artifactIds: string[] = [];
  for (const destination of migrationDestinations) {
    const grid = store.get(destination)!;
    assert.equal(grid.cells[0].status, "complete");
    const exported = store.outputDownload(`cell-${destination}`)!;
    assert.ok(exported.artifactId);
    assert.equal(exported.artifactId, grid.cells[0].artifactId);
    const files = await store.files.bundle(exported.artifactId);
    assert.deepEqual(Object.keys(files), ["messages.json"]);
    const messages: CanonicalMessageJSON[] = JSON.parse(
      Buffer.from(files["messages.json"]).toString("utf8"),
    );
    assert.deepEqual(messages, expectedMigratedMessages(destination));
    assert.equal(messages[4].images![0].dataUrl, generatedDataUrl);
    assert.deepEqual(
      Buffer.from(messages[4].images![0].dataUrl.split(",")[1], "base64"),
      generatedPng,
    );
    artifactIds.push(exported.artifactId);
  }
  assert.notEqual(
    artifactIds[0],
    artifactIds[1],
    "shared legacy output needs distinct canonical artifacts for different destination images",
  );
  return artifactIds;
}

for (const legacyReferenceFiles of [false, true]) {
  test(`Store startup canonically saves shared chat outputs with ${legacyReferenceFiles ? "legacy uploaded files" : "content-addressed references"} and preserves unrelated data`, async (t) => {
    const fixture = chatOutputMigrationFixture(t, { legacyReferenceFiles });
    const before = chatMigrationDatabaseState(fixture.database);
    const oldTasks = storedChatTasks(fixture.database);
    const store = openStore(t, fixture);

    await assertCanonicalSavedMessages(store);
    const after = chatMigrationDatabaseState(fixture.database);
    assert.ok(
      after.version > 19,
      "canonical output migration must commit its version",
    );
    assert.deepEqual(after.foreignKeyViolations, []);
    for (const table of Object.keys(before.tables)) {
      if (table === "workflow_tasks") continue;
      if (
        legacyReferenceFiles &&
        ["reference_images", "reference_blobs"].includes(table)
      )
        continue;
      assert.deepEqual(
        after.tables[table],
        before.tables[table],
        `${table} must be preserved`,
      );
    }
    const tasks = storedChatTasks(fixture.database);
    for (const task of tasks) {
      const old = oldTasks.find(({ id }) => id === task.id)!;
      assert.equal(task.id, old.id);
      assert.equal(task.status, old.status);
      assert.equal(task.thinking_source_id, old.thinking_source_id);
      assert.deepEqual(
        task.data.input,
        old.data.input,
        "accepted inputs retain their reference identities",
      );
      assert.deepEqual(
        task.data.output,
        old.data.output,
        "provenance and usage must not be regenerated",
      );
    }
    assert.deepEqual(
      tasks.find(({ id }) => id === "task-markdown"),
      oldTasks.find(({ id }) => id === "task-markdown"),
    );
    const markdown = store.outputDownload("cell-markdown")!;
    assert.equal(markdown.artifactId, "markdown-artifact");
    assert.equal(
      Buffer.from(
        (await store.files.bundle(markdown.artifactId))["index.md"],
      ).toString(),
      "Unrelated Markdown stays byte-for-byte intact.\n",
    );
    assert.equal(
      store.session("browser-session")!.key,
      "preserved-browser-key",
    );
    assert.equal(store.session("browser-session")!.userId, "account");
    assert.equal(store.user("account")!.username, "saved-user");
    const publicExample = store.get("source")!;
    assert.equal(publicExample.slug, "public-example");
    assert.equal(publicExample.published, true);
    assert.equal(publicExample.visibility, "public");
    assert.equal(publicExample.ownerUserId, "account");
    assert.equal(publicExample.createdAt, "2025-06-07T08:09:10.000Z");
    const thinking = store.files.thinkingPath(
      publicExample.cells[0].thinkingSourceId!,
      publicExample.cells[0].thinkingId!,
    );
    assert.ok(thinking);
    assert.equal(readFileSync(thinking, "utf8"), "Preserved reasoning trace.");
  });
}

test("a second Store construction preserves migrated artifact identities, database records and the complete file inventory", async (t) => {
  const fixture = chatOutputMigrationFixture(t);
  const first = openStore(t, fixture);
  const artifacts = await assertCanonicalSavedMessages(first);
  const state = chatMigrationDatabaseState(fixture.database);
  const inventory = outputFileInventory(fixture.outputs);
  first.db.close();

  const second = openStore(t, fixture);
  assert.deepEqual(await assertCanonicalSavedMessages(second), artifacts);
  assert.deepEqual(chatMigrationDatabaseState(fixture.database), state);
  assert.deepEqual(outputFileInventory(fixture.outputs), inventory);
});

test("failed and live chat prefixes are canonical in durable storage before runtime reads without changing accepted templates or task state", (t) => {
  const fixture = chatOutputMigrationFixture(t);
  const oldTasks = storedChatTasks(fixture.database);
  const store = openStore(t, fixture);
  const tasks = storedChatTasks(fixture.database);
  for (const id of ["failed", "live"]) {
    const task = tasks.find((task) => task.id === `task-${id}`)!;
    const old = oldTasks.find((old) => old.id === task.id)!;
    assert.equal(task.artifact_id, null);
    assert.equal(task.status, id === "failed" ? "error" : "running");
    assert.equal(task.data.attemptId, old.data.attemptId);
    assert.equal(task.data.error, old.data.error);
    assert.deepEqual(task.data.input, old.data.input);
    assert.deepEqual(
      JSON.parse(task.data.progress!.draft!),
      expectedMigratedMessages("source").slice(0, 5),
    );
    assert.deepEqual(
      JSON.parse(store.get(id)!.cells[0].draft!),
      JSON.parse(task.data.progress!.draft!),
      "runtime consumers must see the stored canonical prefix without template repairs",
    );
  }
  assert.deepEqual(
    storedChatTasks(fixture.database),
    tasks,
    "reads must not migrate stored drafts",
  );
});

for (const fault of [
  "missing supplied bytes",
  "database repoint failure",
] as const) {
  test(`startup fails closed on ${fault}, preserves v19 rows and artifacts, and succeeds after the fault is restored`, async (t) => {
    const fixture = chatOutputMigrationFixture(t);
    const restore =
      fault === "missing supplied bytes"
        ? fixture.removeSuppliedImage()
        : failChatArtifactRepoint(fixture.database);
    const before = chatMigrationDatabaseState(fixture.database);
    const inventory = outputFileInventory(fixture.outputs);
    assert.equal(before.version, 19);
    assert.deepEqual(before.foreignKeyViolations, []);

    const startWithFault = () => {
      const unexpected = new Store(
        fixture.database,
        fixture.secret,
        fixture.outputs,
      );
      unexpected.db.close();
    };
    if (fault === "database repoint failure")
      assert.throws(
        startWithFault,
        /fixture rejects canonical artifact repoint/,
      );
    else assert.throws(startWithFault);
    assert.deepEqual(
      chatMigrationDatabaseState(fixture.database),
      before,
      "no partial task repoints or schema version changes may survive failed startup",
    );
    const afterFailureFiles = outputFileInventory(fixture.outputs);
    for (const file of inventory)
      assert.deepEqual(
        afterFailureFiles.find(({ path }) => path === file.path),
        file,
        `failed migration must retain old file ${file.path}`,
      );

    restore();
    const retried = openStore(t, fixture);
    const artifacts = await assertCanonicalSavedMessages(retried);
    assert.ok(chatMigrationDatabaseState(fixture.database).version > 19);
    assert.deepEqual(
      chatMigrationDatabaseState(fixture.database).foreignKeyViolations,
      [],
    );
    const migratedState = chatMigrationDatabaseState(fixture.database);
    const migratedInventory = outputFileInventory(fixture.outputs);
    retried.db.close();

    const reopened = openStore(t, fixture);
    assert.deepEqual(await assertCanonicalSavedMessages(reopened), artifacts);
    assert.deepEqual(
      chatMigrationDatabaseState(fixture.database),
      migratedState,
    );
    assert.deepEqual(outputFileInventory(fixture.outputs), migratedInventory);
  });
}

for (const status of ["pending", "running", "error"] as const)
  test(`startup converts every referenced chat artifact even when its task is ${status}`, async (t) => {
    const fixture = chatOutputMigrationFixture(t, { artifactStatus: status });
    const before = storedChatTasks(fixture.database);
    const store = openStore(t, fixture);
    for (const destination of migrationDestinations) {
      const task = storedChatTasks(fixture.database).find(
        (task) => task.id === `task-${destination}`,
      )!;
      const old = before.find((old) => old.id === task.id)!;
      assert.equal(task.status, status);
      assert.deepEqual(task.data, old.data);
      assert.equal(task.thinking_source_id, old.thinking_source_id);
      assert.ok(task.artifact_id);
      assert.notEqual(task.artifact_id, "shared-chat");
      const saved = await store.files.bundle(task.artifact_id);
      assert.deepEqual(
        JSON.parse(Buffer.from(saved["messages.json"]).toString("utf8")),
        expectedMigratedMessages(destination),
      );
    }
  });

test("startup materializes only supplied turns already present in a partial prefix", (t) => {
  const fixture = chatOutputMigrationFixture(t, { prefixLength: 2 });
  openStore(t, fixture);
  for (const id of ["failed", "live"]) {
    const task = storedChatTasks(fixture.database).find(
      (task) => task.id === `task-${id}`,
    )!;
    assert.deepEqual(
      JSON.parse(task.data.progress!.draft!),
      expectedMigratedMessages("source").slice(0, 2),
      "future supplied assistant images and completion turns must not be appended",
    );
  }
});

test("retry refuses an existing replacement with different bytes instead of overwriting it or committing pointers", async (t) => {
  const fixture = chatOutputMigrationFixture(t);
  const unblock = failChatArtifactRepoint(fixture.database);
  const before = chatMigrationDatabaseState(fixture.database);
  const start = () => {
    const store = new Store(fixture.database, fixture.secret, fixture.outputs);
    store.db.close();
  };
  assert.throws(start, /fixture rejects canonical artifact repoint/);
  unblock();
  const restore = corruptInstalledChatReplacement(fixture.outputs);
  const corrupted = outputFileInventory(fixture.outputs);
  assert.throws(start);
  assert.deepEqual(chatMigrationDatabaseState(fixture.database), before);
  assert.deepEqual(outputFileInventory(fixture.outputs), corrupted);
  restore();
  await assertCanonicalSavedMessages(openStore(t, fixture));
});

test(
  "SIGKILL after immutable artifact installation rolls back WAL migration and restart reuses the installed replacement",
  { timeout: 30000 },
  async (t) => {
    const fixture = chatOutputMigrationFixture(t, {
      legacyReferenceFiles: true,
    });
    const before = chatMigrationDatabaseState(fixture.database);
    const sources = outputFileInventory(fixture.outputs);
    const killed = await killMigrationBeforeArtifactRepoint(fixture);
    assert.equal(killed.journalMode, "wal");
    assert.equal(killed.code, null);
    assert.equal(killed.signal, "SIGKILL");
    assert.notEqual(killed.artifactId, "shared-chat");
    assert.deepEqual(killed.messages, expectedMigratedMessages("source"));
    assert.equal(chatMigrationDatabaseState(fixture.database).version, 19);
    assert.deepEqual(chatMigrationDatabaseState(fixture.database), before);
    const interrupted = outputFileInventory(fixture.outputs);
    const replacement = interrupted.find(
      (file) =>
        file.path === `${encodeURIComponent(killed.artifactId)}/messages.json`,
    );
    assert.ok(replacement);
    for (const source of sources)
      assert.deepEqual(
        interrupted.find((file) => file.path === source.path),
        source,
        `SIGKILL must retain legacy source ${source.path}`,
      );

    const restarted = openStore(t, fixture);
    const artifacts = await assertCanonicalSavedMessages(restarted);
    assert.equal(artifacts[0], killed.artifactId);
    assert.equal(chatMigrationDatabaseState(fixture.database).version, 20);
    const state = chatMigrationDatabaseState(fixture.database);
    const inventory = outputFileInventory(fixture.outputs);
    assert.deepEqual(
      inventory.find((file) => file.path === replacement.path),
      replacement,
      "restart must reuse the already-installed file without rewriting it",
    );
    restarted.db.close();
    const repeated = openStore(t, fixture);
    assert.deepEqual(await assertCanonicalSavedMessages(repeated), artifacts);
    assert.deepEqual(chatMigrationDatabaseState(fixture.database), state);
    assert.deepEqual(outputFileInventory(fixture.outputs), inventory);
  },
);
