import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { OutputFiles } from "../server/files.js";
import type { Model } from "../server/provider.js";
import {
  chatOutputMigrationFixture,
  expectedMigratedMessages,
  type CanonicalMessageJSON,
  type ChatOutputMigrationFixture,
  type MigrationDestination,
} from "./chat-output-migration-fixture.js";
import { pixelPng, referencePng } from "./reference-image-fixture.js";

export {
  chatMigrationDatabaseState as startupMigrationDatabaseState,
  outputFileInventory,
  storedChatTasks,
} from "./chat-output-migration-fixture.js";

const workerVariable = "STARTUP_DATA_MIGRATION_PARALLEL_WORKERS";

function setFixtureEnvironment(
  t: TestContext,
  values: Record<string, string | undefined>,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

export function startupConfigFixture(
  t: TestContext,
  workers: string | undefined,
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-startup-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "app.sqlite");
  const outputs = join(directory, "outputs");
  setFixtureEnvironment(t, {
    [workerVariable]: workers,
    DATABASE_PATH: database,
    OUTPUTS_PATH: outputs,
    GENERATION_SOCKET: join(directory, "generation.sock"),
    KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 23).toString("hex"),
    NODE_ENV: "test",
  });
  return { directory, database, outputs };
}

export const startupMigrationModels: Model[] = [
  {
    id: "retired/multimodal",
    name: "Historical mixed-output generator",
    image: true,
    imageInput: true,
    text: true,
    chatImageOutput: true,
    reasoning: false,
    reasoningMandatory: false,
  },
  {
    id: "historical/text-judge",
    name: "Historical text-only judge",
    image: false,
    imageInput: false,
    text: true,
    reasoning: false,
    reasoningMandatory: false,
    structuredOutputs: true,
  },
];

type HistoricalMessage = {
  role: string;
  content: string;
  images?: { id: string; name: string; width: number; height: number }[];
};

type HistoricalGrid = {
  input: {
    judge: boolean;
    parameters: Record<string, unknown> & {
      input: { kind: string; value: HistoricalMessage[] };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function sourceUsesOnlyAvailableImage(database: string) {
  const db = new Database(database);
  try {
    db.transaction(() => {
      const grid = db
        .prepare<[], { data: string }>(
          "SELECT data FROM grids WHERE id='source'",
        )
        .get()!;
      const task = db
        .prepare<[], { data: string }>(
          "SELECT data FROM workflow_tasks WHERE id='task-source'",
        )
        .get()!;
      const definition = JSON.parse(grid.data) as HistoricalGrid;
      const accepted = JSON.parse(task.data);
      for (const messages of [
        definition.input.parameters.input.value,
        accepted.input.messages as HistoricalMessage[],
      ])
        for (const message of messages)
          for (const image of message.images ?? []) {
            image.id = "small-reference";
            image.width = 1;
            image.height = 1;
          }
      db.prepare("UPDATE grids SET data=? WHERE id='source'").run(
        JSON.stringify(definition),
      );
      db.prepare("UPDATE workflow_tasks SET data=? WHERE id='task-source'").run(
        JSON.stringify(accepted),
      );
      db.prepare(
        "DELETE FROM grid_reference_images WHERE grid_id='source' AND reference_id='wide-reference'",
      ).run();
    })();
  } finally {
    db.close();
  }
}

export function startupMigrationFixture(t: TestContext) {
  const fixture = chatOutputMigrationFixture(t);
  setFixtureEnvironment(t, {
    [workerVariable]: "30",
    DATABASE_PATH: fixture.database,
    OUTPUTS_PATH: fixture.outputs,
    GENERATION_SOCKET: join(fixture.directory, "generation.sock"),
    KEY_ENCRYPTION_SECRET: fixture.secret.toString("hex"),
    NODE_ENV: "test",
  });
  sourceUsesOnlyAvailableImage(fixture.database);
  const files = new OutputFiles(fixture.outputs);
  return {
    ...fixture,
    removeRequiredLateImage() {
      const hash = createHash("sha256").update(referencePng).digest("hex");
      const path = files.referencePath(hash);
      if (!path) throw new Error("Expected the later grid's historical image");
      rmSync(path);
      return () => files.writeReference(hash, referencePng);
    },
  };
}

export function expectedStartupMessages(
  destination: MigrationDestination,
): CanonicalMessageJSON[] {
  const messages = expectedMigratedMessages(destination);
  if (destination === "source")
    for (const index of [1, 2])
      for (const image of messages[index].images ?? []) {
        image.width = 1;
        image.height = 1;
        image.dataUrl = `data:image/png;base64,${pixelPng.toString("base64")}`;
      }
  return messages;
}

export function addHistoricalTextPolicyGrid(
  fixture: ChatOutputMigrationFixture,
) {
  const db = new Database(fixture.database);
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const source = db
        .prepare<[], { data: string }>(
          "SELECT data FROM grids WHERE id='source'",
        )
        .get()!;
      const grid = JSON.parse(source.data) as HistoricalGrid;
      const messages = [
        { role: "user", content: "Write a concise description." },
        { role: "unfilled", content: "" },
      ];
      grid.input.judge = true;
      grid.input.parameters = {
        ...grid.input.parameters,
        input: { kind: "common", value: messages },
        judge_model: { kind: "common", value: "historical/text-judge" },
        judge_effort: { kind: "common", value: "none" },
        judge_criteria: {
          kind: "common",
          value: [{ text: "Is the description concise?", correctAnswer: true }],
        },
        judge_system: { kind: "common", value: "Evaluate the description." },
      };
      grid.status = "paused";
      grid.title = "Historical text-only judging";
      db.prepare(
        `INSERT INTO grids
          (id,data,owner,owner_user_id,published,visibility,created_at)
         VALUES ('text-policy',?,'anonymous-owner','account',0,'private',?)`,
      ).run(JSON.stringify(grid), "2025-06-07T08:09:11.000Z");
      db.prepare(
        `INSERT INTO workflow_tasks (id,grid_id,kind,status,data)
         VALUES ('task-text-policy','text-policy','generation','pending',?)`,
      ).run(
        JSON.stringify({
          input: {
            format: "chat-template",
            model: "retired/multimodal",
            effort: "none",
            prompt: "Write a concise description.",
            messages,
            budgetUsd: 1,
          },
        }),
      );
      db.prepare(
        `INSERT INTO workflow_tasks
          (id,grid_id,kind,status,dependency_id,data)
         VALUES ('judge-text-policy','text-policy','judge','pending','task-text-policy',?)`,
      ).run(
        JSON.stringify({
          input: {
            model: "historical/text-judge",
            effort: "none",
            criteria: [
              { text: "Is the description concise?", correctAnswer: true },
            ],
            systemPrompt: "Evaluate the description.",
          },
        }),
      );
      db.prepare(
        `INSERT INTO cells (id,grid_id,position,data,generation_id,judgment_id)
         VALUES ('cell-text-policy','text-policy',0,'{}','task-text-policy','judge-text-policy')`,
      ).run();
    })();
  } finally {
    db.close();
  }
}
export function addHistoricalImageOnlyChat(
  fixture: ChatOutputMigrationFixture,
  gridId: string,
) {
  const db = new Database(fixture.database);
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const source = db
        .prepare<[], { data: string }>(
          "SELECT data FROM grids WHERE id='source'",
        )
        .get()!;
      const grid = JSON.parse(source.data) as HistoricalGrid;
      const messages = [
        { role: "user", content: "Describe a blue square." },
        { role: "unfilled", content: "" },
      ];
      grid.input.judge = false;
      grid.input.caseAxes = [];
      grid.input.rows = [{ id: "row-1" }];
      grid.input.columns = [{ id: "column-1" }];
      grid.input.parameters = {
        input: { kind: "common", value: messages },
        model: { kind: "common", value: "historical/image-only" },
        effort: { kind: "common", value: "none" },
      };
      grid.status = "paused";
      const taskId = `task-${gridId}`;
      db.prepare(
        `INSERT INTO grids
          (id,data,owner,owner_user_id,published,visibility,created_at)
         VALUES (?,?,'anonymous-owner','account',0,'private',?)`,
      ).run(gridId, JSON.stringify(grid), "2025-06-07T08:09:12.000Z");
      db.prepare(
        `INSERT INTO workflow_tasks (id,grid_id,kind,status,data)
         VALUES (?,?,'generation','pending',?)`,
      ).run(
        taskId,
        gridId,
        JSON.stringify({
          input: {
            format: "chat-template",
            model: "historical/image-only",
            effort: "none",
            prompt: "Describe a blue square.",
            messages,
            budgetUsd: 1,
          },
        }),
      );
      db.prepare(
        `INSERT INTO cells (id,grid_id,position,data,generation_id)
         VALUES (?,?,0,'{}',?)`,
      ).run(`cell-${gridId}`, gridId, taskId);
    })();
  } finally {
    db.close();
  }
}

export function storedTextPolicy(database: string) {
  const db = new Database(database, { readonly: true });
  try {
    const grid = db
      .prepare<[], { data: string }>(
        "SELECT data FROM grids WHERE id='text-policy'",
      )
      .get()!;
    const tasks = db
      .prepare<[], { id: string; status: string; data: string }>(
        "SELECT id,status,data FROM workflow_tasks WHERE grid_id='text-policy' ORDER BY rowid",
      )
      .all();
    return {
      grid: JSON.parse(grid.data) as HistoricalGrid,
      tasks: tasks.map((task) => ({ ...task, data: JSON.parse(task.data) })),
    };
  } finally {
    db.close();
  }
}
