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
  restoreV15ReferenceSchema,
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
  for (const version of [7, 18]) {
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
        provenance: { signature: "", files: ["index.md"] },
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

test("v15 blob migration preserves content identity and enforces paired positive integer proportions", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    insertReferenceBlobDimensions(db, "a".repeat(64), 7, 3);
    restoreV15ReferenceSchema(db);
    initializeDatabase(db);
    assert.equal(migration.databaseVersion(db), 17);
    assert.deepEqual(referenceBlobs(db), [
      { sha256: "a".repeat(64), width: null, height: null },
    ]);
    insertReferenceBlobDimensions(db, "b".repeat(64), 3, 7);
    for (const [width, height] of [
      [null, 3],
      [7, null],
      [0, 3],
      [7, -1],
      [1.5, 3],
      [7, 2.5],
    ] as const)
      assert.throws(
        () => insertReferenceBlobDimensions(db, "c".repeat(64), width, height),
        /CHECK constraint failed|cannot store REAL value/,
      );
    assert.deepEqual(referenceBlobs(db), [
      { sha256: "a".repeat(64), width: null, height: null },
      { sha256: "b".repeat(64), width: 3, height: 7 },
    ]);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});

test("v16 variable migration changes templates only and preserves accepted tasks, receipts and metadata", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    initializeDatabase(db);
    const legacyInput = {
      ...input,
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
    migration.restoreV16VariableInputs(db, legacyInput);
    migration.retainExpandedVariableTaskText(db);
    const before = snapshot(db);
    initializeDatabase(db);
    const after = snapshot(db);
    assert.equal(after.version, 17);
    assert.deepEqual(after.schema, before.schema);
    assert.deepEqual(
      after.rows.filter(([table]) => table !== "grids"),
      before.rows.filter(([table]) => table !== "grids"),
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

test("v16 template migration rolls back all grids and the version when a later grid write fails", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    initializeDatabase(db);
    migration.restoreV16VariableInputs(db, {
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

test("v17 backfills variable field and chat references while retaining historical usage links", () => {
  const db = legacyDatabase(13);
  try {
    seedLegacy(db, 13);
    initializeDatabase(db);
    migration.restoreV16VariableInputs(db, {
      ...input,
      prompt: "$ROW1",
      rows: {
        kind: "variable",
        values: [
          [
            { text: "used", images: [{ id: "field-used", name: "used.png" }] },
            {
              text: "unused",
              images: [{ id: "field-unused", name: "unused.png" }],
            },
          ],
        ],
      },
      messages: [
        {
          role: "user",
          content: "image",
          images: [{ id: "message", name: "message.png" }],
        },
      ],
    });
    initializeDatabase(db);
    assert.deepEqual(migration.migratedGridReferenceIds(db), [
      { reference_id: "field-unused" },
      { reference_id: "field-used" },
      { reference_id: "message" },
      { reference_id: "missing-reference" },
      { reference_id: "reference" },
      { reference_id: "unused-reference" },
    ]);
    assert.deepEqual(migration.foreignKeyViolations(db), []);
  } finally {
    db.close();
  }
});
