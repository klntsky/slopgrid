import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Billing } from "../server/billing.js";
import { initializeDatabase } from "../server/database.js";
import { migrateVariableInput } from "../shared/variable-migration.js";

import * as migration from "./database-migration-fixture.js";
import {
  insertReferenceBlobDimensions,
  referenceBlobs,
} from "./reference-storage-fixture.js";

const { legacyDatabase, seedLegacy, storedData, snapshot, input, createdAt } =
  migration;

test("production v12 migrates ownership, sessions, references and billing without changing identity or order", () => {
  const db = legacyDatabase(12);
  try {
    seedLegacy(db, 12);
    const before = migration.migratedRecordIdentities(db);
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.deepEqual(migration.migratedRecordIdentities(db), before);
    assert.deepEqual(migration.migratedGridOwnership(db), {
      owner: "anonymous",
      owner_user_id: "account",
      published: 1,
      visibility: "public",
      slug: "saved-grid",
      created_at: createdAt,
    });
    const gridData = storedData(db, "grid");
    assert.deepEqual(gridData, {
      input: migrateVariableInput(input),
      status: "paused",
      title: "Saved",
      author: { name: "Author" },
      expanded_prompt_for_title: input.prompt,
    });
    assert.equal(
      storedData(db, "private-grid").expanded_prompt_for_title,
      "Already expanded",
    );
    assert.deepEqual(migration.migratedSession(db), {
      anonymous_id: "anonymous",
      created_at: 123456,
      data: JSON.stringify({
        userId: "account",
        key: "encrypted-key",
        keyOAuth: { state: "oauth-state" },
        inferenceConcurrency: 3,
      }),
    });
    assert.deepEqual(migration.migratedGridReferenceIds(db), [
      { reference_id: "missing-reference" },
      { reference_id: "reference" },
      { reference_id: "unused-reference" },
    ]);
    assert.deepEqual(migration.migratedCreationReceipts(db), [
      {
        owner: "anonymous",
        request_id: "request",
        fingerprint: "fingerprint",
        grid_id: "grid",
      },
    ]);
    assert.deepEqual(migration.migratedOAuthIdentities(db), [
      { provider: "github", subject: "42", user_id: "account" },
    ]);
    assert.deepEqual(migration.migratedReferenceImages(db), [
      {
        id: "reference",
        owner: "anonymous",
        owner_user_id: "account",
        name: "photo.png",
        media_type: "image/png",
        sha256: null,
      },
    ]);
    assert.equal(migration.generationEpoch(db).epoch, 37);
    const paid = migration.migratedPaidCall(db);
    assert.deepEqual(paid, {
      task_id: "g:cell",
      attempt_id: "attempt",
      phase: "image",
      status: "succeeded",
      cost_usd: 0.25,
      data: JSON.stringify({
        finishedAt: 101,
        generationId: "provider-id",
        completion: { phase: "image", finishReason: "stop" },
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    });
    const generation = migration.firstMigratedGeneration(db);
    assert.equal(generation.status, "complete");
    assert.equal(generation.artifact_id, "cell");
    assert.equal(generation.thinking_source_id, "cell");
    const billing = new Billing(db);
    assert.deepEqual(billing.task("g:cell", "attempt")?.usage, {
      costUsd: 0.25,
      inputTokens: 15,
      outputTokens: 20,
    });
    assert.deepEqual(billing.task("g:cell")?.usage, { outputTokens: 3 });
    assert.equal(billing.page("anonymous", 0).total, 0);
    const page = billing.page("anonymous", 0, "account");
    assert.deepEqual(
      {
        total: page.total,
        costUsd: page.costUsd,
        unavailable: page.unavailable,
        running: page.running,
      },
      { total: 3, costUsd: 0.25, unavailable: 1, running: 1 },
    );
    assert.deepEqual(
      page.calls.map((call) => [call.id, call.phase, call.usage?.costUsd]),
      [
        ["unknown", "direct", undefined],
        ["paid", "image", 0.25],
        ["free", "direct", 0],
      ],
    );
    assert.equal(page.calls[1].generationId, "provider-id");
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
    assert.throws(
      () => migration.givePrivateGridDuplicateSlug(db),
      /UNIQUE constraint failed/,
    );
    migration.removePrivateLegacyGrid(db);
    assert.deepEqual(migration.privateLegacyGridReferences(db), []);
  } finally {
    db.close();
  }
});

for (const version of [8, 9, 10, 11, 13]) {
  test(`production v${version} upgrades directly to v17 with historical metadata intact`, () => {
    const db = legacyDatabase(version);
    try {
      seedLegacy(db, version);
      initializeDatabase(db);
      assert.equal(migration.databaseVersion(db), 17);
      const data = storedData(db, "grid");
      assert.equal(data.expanded_prompt_for_title, input.prompt);
      assert.equal(data.revision, undefined);
      assert.equal(data.hasUnsettledCalls, undefined);
      assert.equal(migration.migratedGridOwnership(db).owner, "anonymous");
      assert.equal(migration.migratedSession(db).created_at, 123456);
      assert.equal(
        new Billing(db).page("anonymous", 0, "account").costUsd,
        0.25,
      );
      assert.equal(migration.generationEpoch(db).epoch, version >= 10 ? 37 : 0);
      assert.equal(
        migration.migratedCreationReceipts(db).length,
        version >= 11 ? 1 : 0,
      );
      assert.deepEqual(migration.foreignKeyViolations(db), []);
      const stable = snapshot(db);
      initializeDatabase(db);
      assert.deepEqual(snapshot(db), stable);
    } finally {
      db.close();
    }
  });
}

test("a failed upgrade chain rolls back columns, payloads, indexes and version atomically", () => {
  const db = legacyDatabase(12);
  try {
    seedLegacy(db, 12);
    const allowBackfill = migration.rejectInferenceBackfill(db);
    const before = snapshot(db);
    assert.throws(() => initializeDatabase(db), /backfill blocked/);
    assert.deepEqual(snapshot(db), before);
    allowBackfill();
    initializeDatabase(db);
    assert.equal(new Billing(db).page("anonymous", 0, "account").total, 3);
  } finally {
    db.close();
  }
});

test("fresh databases use the canonical schema and reject invalid published flags", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    migration.insertPublicationBoundaryGrid(db, "grid", 0, "private");
    assert.throws(
      () =>
        migration.insertPublicationBoundaryGrid(db, "invalid", 2, "private"),
      /CHECK constraint failed/,
    );
    migration.seedEncryptedMigrationSession(db);
    const before = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("unsupported versions leave stored data untouched", () => {
  for (const version of [7, 15, 16, 18]) {
    const db = legacyDatabase(version);
    try {
      seedLegacy(db, version);
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

test("v13 judged groups preserve generation artifacts, independent judgments and unfinished traces", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    const judgedInput = {
      ...input,
      format: "chat-template",
      prompt: "Answer $COLUMN",
      inputReferences: undefined,
      referenceGroups: undefined,
      messages: [
        { role: "user", content: "Answer $COLUMN" },
        { role: "unfilled", content: "" },
      ],
      rows: { kind: "judge_model", values: ["judge-a", "judge-b"] },
      columns: { kind: "variable", values: ["one", "two"] },
      judge: {
        model: "",
        effort: "high",
        criteria: [{ text: "Correct?", correctAnswer: true }],
      },
    };
    const gridData = storedData(db, "grid");
    migration.replaceLegacyGridData(db, { ...gridData, input: judgedInput });
    const provenance = {
      signature: "saved-signature",
      files: ["index.md"],
      templateSteps: [{ maxOutputTokens: 99, usage: { costUsd: 0.25 } }],
    };
    migration.replaceLegacyCellData(db, {
      model: "saved-model",
      effort: "high",
      prompt: "Saved prompt",
      messages: [{ role: "user", content: "Saved message" }],
      budgetUsd: 0.75,
      status: "error",
      generationSourceId: "cell",
      generationStatus: "complete",
      attemptId: "generation-attempt",
      thinkingId: "generation-trace",
      provenance,
      usage: { costUsd: 0.25 },
      judge: {
        model: "judge-a",
        effort: "high",
        status: "error",
        attemptId: "judge-attempt",
        error: "Invalid judgment",
        errorCode: 422,
      },
    });
    migration.insertLegacyGridCell(db, "unfinished", 1, {
      status: "running",
      generationSourceId: "unfinished",
      generationStatus: "running",
      attemptId: "unfinished-attempt",
      thinkingId: "unfinished-trace",
      draft: "Retained assistant text",
    });
    const results = [{ verdict: true, explanation: "Correct" }];
    migration.insertLegacyGridCell(db, "member", 2, {
      status: "complete",
      generationSourceId: "cell",
      thinkingId: "copied-trace",
      provenance,
      judge: {
        model: "judge-b",
        effort: "high",
        status: "complete",
        results,
      },
    });
    migration.insertLegacyGridCell(db, "waiting", 3, {
      status: "pending",
      generationSourceId: "unfinished",
    });
    migration.seedLegacyJudgmentCall(db);
    const identities = migration.migratedCellIdentities(db);
    initializeDatabase(db);
    assert.deepEqual(migration.migratedCellIdentities(db), identities);
    assert.deepEqual(migration.migratedWorkflowLinks(db), [
      {
        id: "g:cell",
        kind: "generation",
        status: "complete",
        dependency_id: null,
        artifact_id: "cell",
        thinking_source_id: "cell",
      },
      {
        id: "j:cell",
        kind: "judge",
        status: "error",
        dependency_id: "g:cell",
        artifact_id: null,
        thinking_source_id: null,
      },
      {
        id: "j:member",
        kind: "judge",
        status: "complete",
        dependency_id: "g:cell",
        artifact_id: null,
        thinking_source_id: null,
      },
      {
        id: "g:unfinished",
        kind: "generation",
        status: "running",
        dependency_id: null,
        artifact_id: null,
        thinking_source_id: "unfinished",
      },
      {
        id: "j:unfinished",
        kind: "judge",
        status: "pending",
        dependency_id: "g:unfinished",
        artifact_id: null,
        thinking_source_id: null,
      },
      {
        id: "j:waiting",
        kind: "judge",
        status: "pending",
        dependency_id: "g:unfinished",
        artifact_id: null,
        thinking_source_id: null,
      },
    ]);
    const taskData = Object.fromEntries(
      migration
        .migratedTaskPayloads(db)
        .map((row) => [row.id, JSON.parse(row.data)]),
    );
    assert.deepEqual(taskData["g:cell"], {
      input: {
        format: "chat-template",
        model: "saved-model",
        effort: "high",
        prompt: "Saved prompt",
        messages: [{ role: "user", content: "Saved message" }],
        budgetUsd: 0.75,
      },
      attemptId: "generation-attempt",
      output: {
        provenance,
        usage: { costUsd: 0.25 },
        thinkingId: "generation-trace",
      },
    });
    assert.deepEqual(taskData["j:cell"], {
      input: {
        model: "judge-a",
        effort: "high",
        criteria: judgedInput.judge.criteria,
      },
      attemptId: "judge-attempt",
      error: "Invalid judgment",
      errorCode: 422,
    });
    assert.deepEqual(taskData["j:member"].output, { results });
    assert.deepEqual(taskData["g:unfinished"].progress, {
      thinkingId: "unfinished-trace",
      draft: "Retained assistant text",
    });
    assert.deepEqual(migration.migratedCellTaskLinks(db), [
      {
        id: "cell",
        generation_id: "g:cell",
        judgment_id: "j:cell",
      },
      {
        id: "unfinished",
        generation_id: "g:unfinished",
        judgment_id: "j:unfinished",
      },
      {
        id: "member",
        generation_id: "g:cell",
        judgment_id: "j:member",
      },
      {
        id: "waiting",
        generation_id: "g:unfinished",
        judgment_id: "j:waiting",
      },
    ]);
    assert.deepEqual(migration.migratedJudgmentCall(db), {
      task_id: "j:member",
      data: JSON.stringify({ generationId: "provider-judge-id" }),
    });
    assert.equal(new Billing(db).gridSpent("grid", []), 0.75);
    assert.equal(new Billing(db).task("j:member")?.usage?.costUsd, 0.5);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
  } finally {
    db.close();
  }
});

test("v14 workflow backfill failure restores a production v13 database atomically", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    const allowCellBackfill = migration.rejectCellWorkflowBackfill(db);
    const before = snapshot(db);
    assert.throws(() => initializeDatabase(db), /workflow blocked/);
    assert.deepEqual(snapshot(db), before);
    allowCellBackfill();
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
  } finally {
    db.close();
  }
});

test("fresh and upgraded databases enforce publication, slug uniqueness and grid cleanup", () => {
  for (const version of [0, 13]) {
    const db =
      version === 0 ? new Database(":memory:") : legacyDatabase(version);
    try {
      migration.enableForeignKeys(db);
      if (version) seedLegacy(db, version);
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
            "duplicate-slug",
            1,
            "public",
            "unique-public-slug",
          ),
        /UNIQUE constraint failed/,
      );
      assert.throws(
        () =>
          migration.insertPublicationBoundaryGrid(
            db,
            "invalid-publication",
            2,
            "public",
          ),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => migration.insertBoundaryCell(db, "orphan-cell", "missing-grid"),
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

test("legacy key grouping shares judged output only and keeps the physical output owner", () => {
  for (const judged of [false, true]) {
    const db = legacyDatabase(13);
    try {
      seedLegacy(db, 13);
      const migratedInput = {
        ...input,
        prompt: "Identical generation input",
        rows: judged
          ? { kind: "judge_model", values: ["judge-a", "judge-b"] }
          : { kind: "variable", values: ["one", "two"] },
        ...(judged
          ? {
              judge: {
                model: "",
                effort: "high",
                criteria: [{ text: "Correct?", correctAnswer: true }],
              },
            }
          : {}),
      };
      migration.replaceLegacyGridData(db, {
        ...storedData(db, "grid"),
        input: migratedInput,
      });
      migration.replaceLegacyCellData(db, {
        status: "pending",
        thinkingId: "unfinished-trace",
        attemptId: "unfinished-attempt",
      });
      migration.insertLegacyGridCell(db, "physical-owner", 1, {
        status: "complete",
        thinkingId: "saved-trace",
        attemptId: "committed-attempt",
        usage: { costUsd: 0.25 },
      });
      initializeDatabase(db);
      assert.equal(
        migration.migratedTaskCount(db, "generation"),
        judged ? 1 : 2,
      );
      const physical = migration.migratedPhysicalGeneration(db);
      assert.equal(physical.id, judged ? "g:cell" : "g:physical-owner");
      assert.equal(physical.thinking_source_id, "physical-owner");
      assert.equal(JSON.parse(physical.data).attemptId, "committed-attempt");
      assert.deepEqual(JSON.parse(physical.data).output, {
        provenance: { signature: "", files: ["image"] },
        thinkingId: "saved-trace",
        usage: { costUsd: 0.25 },
      });
      assert.equal(migration.migratedTaskCount(db, "judge"), judged ? 2 : 0);
      assert.deepEqual(migration.foreignKeyViolations(db), []);
    } finally {
      db.close();
    }
  }
});

test("legacy chat output without provenance uses the canonical conversation inventory", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    migration.replaceLegacyGridData(db, {
      ...storedData(db, "grid"),
      input: {
        ...input,
        format: "chat-template",
        messages: [
          { role: "user", content: "Saved question" },
          { role: "unfilled", content: "" },
        ],
      },
    });
    initializeDatabase(db);
    const row = migration.migratedChatGeneration(db);
    assert.equal(row.artifact_id, "cell");
    assert.deepEqual(JSON.parse(row.data).output.provenance, {
      signature: "",
      files: ["messages.json"],
    });
  } finally {
    db.close();
  }
});

test("legacy completed output without an attempt retains its own reported usage", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    migration.replaceLegacyCellData(db, { status: "complete" });
    migration.seedUnattributedLegacyCharge(db);
    initializeDatabase(db);
    const task = JSON.parse(migration.migratedChatGeneration(db).data);
    assert.deepEqual(task.output.usage, {
      inputTokens: 4,
      outputTokens: 6,
      costUsd: 0,
    });
    assert.equal(task.attemptId, undefined);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});

test("fresh and production v14 upgrades enforce paired positive integer proportions", () => {
  for (const version of [0, 14]) {
    const db =
      version === 0 ? new Database(":memory:") : legacyDatabase(version);
    try {
      if (version) seedLegacy(db, version);
      const references = version ? migration.migratedReferenceImages(db) : [];
      initializeDatabase(db);
      assert.equal(migration.databaseVersion(db), 17);
      assert.deepEqual(
        migration.migratedReferenceImages(db),
        references.map((reference) => ({ ...reference, sha256: null })),
      );
      assert.deepEqual(referenceBlobs(db), []);
      insertReferenceBlobDimensions(db, "a".repeat(64), null, null);
      insertReferenceBlobDimensions(db, "b".repeat(64), 3, 7);
      insertReferenceBlobDimensions(db, "d".repeat(64), 1, 1);
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
        { sha256: "d".repeat(64), width: 1, height: 1 },
      ]);
      assert.deepEqual(migration.foreignKeyViolations(db), []);
      const stable = snapshot(db);
      initializeDatabase(db);
      assert.deepEqual(snapshot(db), stable);
    } finally {
      db.close();
    }
  }
});

test("production v14 upgrades templates without changing accepted tasks, receipts or metadata", () => {
  const db = legacyDatabase(14);
  try {
    seedLegacy(db, 14);
    const {
      inputReferences: _references,
      referenceGroups: _groups,
      ...textInput
    } = input;
    const legacyInput = {
      ...textInput,
      format: "chat-template",
      prompt: "Compare $ROW and $COLUMN; $ROW1 $ROWS $ROW_suffix",
      rows: { kind: "variable", values: ["Literal $ROW", "two"] },
      columns: { kind: "variable", values: ["Literal $COLUMN"] },
      messages: [{ role: "user", content: "$ROW versus $COLUMN" }],
      judge: {
        model: "judge",
        effort: "none",
        criteria: [
          { text: "Is $ROW better than $COLUMN?", correctAnswer: false },
        ],
      },
    };
    migration.replaceLegacyGridInputs(db, legacyInput);
    migration.retainExpandedVariableTaskText(db);
    const references = migration.migratedReferenceImages(db);
    const identities = migration.migratedRecordIdentities(db);
    const before = snapshot(db);
    initializeDatabase(db);
    const after = snapshot(db);
    assert.equal(after.version, 17);
    assert.deepEqual(migration.migratedRecordIdentities(db), identities);
    assert.deepEqual(
      migration.migratedReferenceImages(db),
      references.map((reference) => ({ ...reference, sha256: null })),
    );
    assert.deepEqual(
      after.rows.filter(
        ([table]) =>
          table !== "grids" &&
          table !== "reference_images" &&
          table !== "reference_blobs",
      ),
      before.rows.filter(
        ([table]) => table !== "grids" && table !== "reference_images",
      ),
    );
    const data = storedData(db, "grid");
    assert.deepEqual(data, {
      ...storedData(db, "private-grid"),
      input: migrateVariableInput(legacyInput),
      status: "paused",
      title: "Saved",
      author: { name: "Author" },
      expanded_prompt_for_title: input.prompt,
    });
    assert.equal(
      storedData(db, "private-grid").expanded_prompt_for_title,
      "Already expanded",
    );
    const stable = snapshot(db);
    initializeDatabase(db);
    assert.deepEqual(snapshot(db), stable);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});

test("production v14 upgrade rolls back its SQL, grids and version when a later template write fails", () => {
  const db = legacyDatabase(14);
  try {
    seedLegacy(db, 14);
    migration.replaceLegacyGridInputs(db, {
      ...input,
      prompt: "Hello $ROW",
    });
    const unblock = migration.rejectVariableTemplateMigration(db);
    const before = snapshot(db);
    assert.throws(() => initializeDatabase(db), /variable migration blocked/);
    assert.deepEqual(snapshot(db), before);
    unblock();
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.equal(storedData(db, "grid").input.prompt, "Hello $ROW1");
  } finally {
    db.close();
  }
});

test("production v14 upgrade backfills Image group references while retaining historical usage links", () => {
  const db = legacyDatabase(14);
  try {
    seedLegacy(db, 14);
    migration.replaceLegacyGridInputs(db, {
      ...input,
      rows: { kind: "input_references", values: ["selected"] },
      referenceGroups: {
        selected: [{ id: "group-image", name: "group.png" }],
      },
    });
    initializeDatabase(db);
    assert.deepEqual(migration.migratedGridReferenceIds(db), [
      { reference_id: "group-image" },
      { reference_id: "missing-reference" },
      { reference_id: "reference" },
      { reference_id: "unused-reference" },
    ]);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});

test("legacy workflow restoration preserves a literal common rubric for every case", () => {
  const criteria = [
    { text: "Does $ROW match $COLUMN1?", correctAnswer: false },
  ];
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    const source = {
      ...input,
      format: "markdown",
      prompt: "Describe a shape.",
      inputReferences: undefined,
      referenceGroups: undefined,
      rows: {
        kind: "variable",
        values: ["answer 0", "answer 1"],
      },
      columns: { kind: "effort", values: ["none"] },
      judge: { model: "judge", effort: "high", criteria },
    };
    migration.replaceLegacyGridData(db, {
      ...storedData(db, "grid"),
      input: source,
    });
    migration.replaceLegacyCellData(db, { status: "pending" });
    migration.insertLegacyGridCell(db, "second-case", 1, {
      status: "pending",
    });
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.deepEqual(storedData(db, "grid").input.judge.criteria, criteria);
    const tasks = Object.fromEntries(
      migration
        .migratedTaskPayloads(db)
        .map((row) => [row.id, JSON.parse(row.data)]),
    );
    assert.deepEqual(tasks["j:cell"].input, {
      model: "judge",
      effort: "high",
      criteria,
    });
    assert.deepEqual(tasks["j:second-case"].input, {
      model: "judge",
      effort: "high",
      criteria,
    });
    assert.equal(migration.migratedTaskCount(db, "generation"), 1);
    assert.equal(tasks["g:cell"].input.prompt, source.prompt);
    assert.equal(tasks["g:cell"].input.images, undefined);
  } finally {
    db.close();
  }
});
