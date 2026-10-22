import type Database from "better-sqlite3";
import type { Cell, StoredGridInput } from "./domain.js";
import { generationGroupKey } from "../shared/generation-key.js";
import { migrateVariableInput } from "../shared/variable-migration.js";
import {
  expandLegacyGrid,
  resolveLegacyCriteriaForCell,
  type LegacyGridInput,
} from "./legacy-grid-input.js";
import { selectedReferences } from "./image-settings.js";

const schemaVersion = 17;
export function initializeDatabase(db: Database.Database) {
  const version = db.pragma("user_version", { simple: true });
  if (version === schemaVersion) return;
  if (
    typeof version !== "number" ||
    ![0, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version)
  )
    throw new Error("Unsupported database version");
  db.transaction(() => {
    if (version === 0)
      db.exec(`
      CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE cells (
        id TEXT PRIMARY KEY,
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (grid_id, position)
      ) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE inference_calls (
        id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL REFERENCES cells(id),
        started_at INTEGER NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX inference_calls_cell ON inference_calls(cell_id, started_at);
      CREATE INDEX inference_calls_started ON inference_calls(started_at DESC, id DESC);
      CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE oauth_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY (provider, subject)
      ) STRICT;
    `);
    if (version < 9)
      db.exec(`CREATE TABLE reference_images (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, media_type TEXT NOT NULL
    ) STRICT;`);
    if (version < 10)
      db.exec(`
      CREATE TABLE generation_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
      ) STRICT;
      INSERT INTO generation_clock VALUES (1, 0);
      UPDATE grids SET data=json_remove(data, '$.revision', '$.hasUnsettledCalls');
    `);
    if (version < 11)
      db.exec(`CREATE TABLE creation_requests (
      owner TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
      PRIMARY KEY (owner, request_id)
    ) STRICT;`);
    if (version < 13) {
      // Add columns in place: rebuilding tables would change rowid tie ordering.
      db.exec(`
        DROP INDEX IF EXISTS grids_slug;
        ALTER TABLE grids ADD COLUMN owner TEXT NOT NULL DEFAULT '';
        ALTER TABLE grids ADD COLUMN owner_user_id TEXT;
        ALTER TABLE grids ADD COLUMN published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1));
        ALTER TABLE grids ADD COLUMN visibility TEXT NOT NULL DEFAULT '';
        ALTER TABLE grids ADD COLUMN slug TEXT;
        ALTER TABLE grids ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions ADD COLUMN anonymous_id TEXT;
        ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE inference_calls ADD COLUMN attempt_id TEXT;
        ALTER TABLE inference_calls ADD COLUMN phase TEXT NOT NULL DEFAULT '';
        ALTER TABLE inference_calls ADD COLUMN status TEXT NOT NULL DEFAULT '';
        ALTER TABLE inference_calls ADD COLUMN cost_usd REAL;
        UPDATE grids SET
          owner=json_extract(data,'$.owner'),
          owner_user_id=json_extract(data,'$.ownerUserId'),
          published=json_extract(data,'$.published'),
          visibility=json_extract(data,'$.visibility'),
          slug=json_extract(data,'$.slug'),
          created_at=json_extract(data,'$.createdAt');
        UPDATE grids SET data=json_set(data,
          '$.expanded_prompt_for_title',json_extract(data,'$.input.prompt'))
          WHERE json_type(data,'$.expanded_prompt_for_title') IS NULL;
        UPDATE grids SET data=json_remove(data,
          '$.owner','$.ownerUserId','$.published','$.visibility','$.slug','$.createdAt');
        UPDATE sessions SET
          anonymous_id=json_extract(data,'$.anonymousId'),
          created_at=json_extract(data,'$.created'),
          data=json_remove(data,'$.anonymousId','$.created');
        UPDATE inference_calls SET
          attempt_id=json_extract(data,'$.attemptId'),
          phase=json_extract(data,'$.phase'),
          status=json_extract(data,'$.status'),
          cost_usd=json_extract(data,'$.usage.costUsd'),
          data=json_remove(data,'$.attemptId','$.phase','$.status','$.usage.costUsd');
      `);
      db.exec(`
      CREATE UNIQUE INDEX grids_slug ON grids(slug);
      CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
      CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
      CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
      CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at DESC);
      CREATE INDEX inference_calls_attempt ON inference_calls(cell_id,attempt_id,started_at) WHERE phase!='judge';
      CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
      CREATE TABLE grid_reference_images (
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL,
        PRIMARY KEY (grid_id,reference_id)
      ) STRICT;
      CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
      INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id)
        SELECT g.id,json_extract(r.value,'$.id')
        FROM grids g,json_each(g.data,'$.input.inputReferences') r;
      INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id)
        SELECT g.id,json_extract(r.value,'$.id')
        FROM grids g,json_each(g.data,'$.input.referenceGroups') reference_group,
          json_each(reference_group.value) r;
      `);
    }
    if (version < 14) {
      db.exec(`
      CREATE TABLE workflow_tasks (
        id TEXT PRIMARY KEY,
        grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL,
        dependency_id TEXT REFERENCES workflow_tasks(id),
        artifact_id TEXT, thinking_source_id TEXT, data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX workflow_tasks_grid ON workflow_tasks(grid_id);
      CREATE INDEX workflow_tasks_artifact ON workflow_tasks(artifact_id)
        WHERE artifact_id IS NOT NULL;
      CREATE INDEX workflow_tasks_thinking_source ON workflow_tasks(thinking_source_id)
        WHERE thinking_source_id IS NOT NULL;
      ALTER TABLE cells ADD COLUMN generation_id TEXT REFERENCES workflow_tasks(id);
      ALTER TABLE cells ADD COLUMN judgment_id TEXT REFERENCES workflow_tasks(id);
      ALTER TABLE inference_calls ADD COLUMN task_id TEXT REFERENCES workflow_tasks(id);
      DROP INDEX inference_calls_attempt;
      CREATE INDEX inference_calls_attempt ON inference_calls(task_id,attempt_id,started_at);
      CREATE INDEX inference_calls_task ON inference_calls(task_id,started_at);
      `);
      if (version !== 0) migrateWorkflow(db);
    }
    if (version < 15)
      db.exec(`
      CREATE TABLE reference_blobs (
        sha256 TEXT PRIMARY KEY CHECK (length(sha256)=64)
      ) STRICT;
      ALTER TABLE reference_images ADD COLUMN sha256 TEXT REFERENCES reference_blobs(sha256);
      CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
    `);
    if (version < 16)
      db.exec(`
        ALTER TABLE reference_blobs ADD COLUMN width INTEGER
          CHECK (width IS NULL OR width > 0);
        ALTER TABLE reference_blobs ADD COLUMN height INTEGER
          CHECK ((width IS NULL AND height IS NULL) OR
            (width IS NOT NULL AND height IS NOT NULL AND height > 0));
      `);
    migrateVariables(db);
    db.pragma(`user_version = ${schemaVersion}`);
  }).immediate();
}

function migrateVariables(db: Database.Database) {
  const grids = db
    .prepare("SELECT id,data FROM grids ORDER BY rowid")
    .all() as {
    id: string;
    data: string;
  }[];
  const save = db.prepare("UPDATE grids SET data=? WHERE id=?");
  const link = db.prepare(
    "INSERT OR IGNORE INTO grid_reference_images (grid_id,reference_id) VALUES (?,?)",
  );
  for (const grid of grids) {
    const data = JSON.parse(grid.data) as { input: StoredGridInput };
    const input = migrateVariableInput(data.input) as StoredGridInput;
    if (input !== data.input)
      save.run(JSON.stringify({ ...data, input }), grid.id);
    // Backfill configured attachments without removing existing links, including
    // historical links retained for accepted workflow payloads.
    for (const image of selectedReferences(input)) link.run(grid.id, image.id);
  }
}

type LegacyCell = Cell & {
  generationSourceId?: string;
  generationStatus?: Cell["status"];
};

function legacyInventory(format: LegacyGridInput["format"]): string[] {
  if (format === "image") return ["image"];
  if (format === "svg") return ["index.svg"];
  if (format === "html") return ["index.html"];
  if (format === "chat-template") return ["messages.json"];
  return ["index.md"];
}

function migrateWorkflow(db: Database.Database) {
  const insertTask = db.prepare(
    `INSERT INTO workflow_tasks
      (id,grid_id,kind,status,dependency_id,artifact_id,thinking_source_id,data)
      VALUES (?,?,?,?,?,?,?,?)`,
  );
  const linkCell = db.prepare(
    "UPDATE cells SET generation_id=?,judgment_id=?,data='{}' WHERE id=?",
  );
  const latestCall = db.prepare(
    "SELECT data,cost_usd FROM inference_calls WHERE cell_id=? AND phase!='judge' ORDER BY started_at DESC,rowid DESC LIMIT 1",
  );
  const grids = db
    .prepare("SELECT id,data FROM grids ORDER BY rowid")
    .all() as {
    id: string;
    data: string;
  }[];
  for (const grid of grids) {
    const savedGrid = JSON.parse(grid.data) as { input: LegacyGridInput };
    const input = migrateVariableInput(savedGrid.input) as LegacyGridInput;
    const rows = db
      .prepare(
        "SELECT id,position,data FROM cells WHERE grid_id=? ORDER BY position",
      )
      .all(grid.id) as { id: string; position: number; data: string }[];
    if (!rows.length) continue;
    const expanded = expandLegacyGrid(input);
    const groups = new Map<string, LegacyCell[]>();
    for (const row of rows) {
      const saved = JSON.parse(row.data) as Partial<LegacyCell>;
      const cell = {
        ...expanded[row.position],
        ...saved,
        id: row.id,
      } as LegacyCell;
      if (cell.judge && !saved.judge && cell.status === "complete")
        cell.judge = { ...cell.judge, status: "complete" };
      const key = cell.judge
        ? cell.generationSourceId
          ? `source:${cell.generationSourceId}`
          : `group:${generationGroupKey(input.format, cell)}`
        : `cell:${cell.id}`;
      const group = groups.get(key);
      if (group) group.push(cell);
      else groups.set(key, [cell]);
    }
    for (const cells of groups.values()) {
      const source =
        cells.find((cell) => cell.generationSourceId === cell.id) ?? cells[0];
      const committed = (cell: LegacyCell) =>
        cell.status === "complete" ||
        (Boolean(cell.judge) &&
          (cell.generationStatus === "complete" ||
            Boolean(cell.provenance?.files.length)));
      const outputCell = committed(source) ? source : cells.find(committed);
      const traceCell = outputCell
        ? outputCell.thinkingId
          ? outputCell
          : undefined
        : source.thinkingId
          ? source
          : cells.find((cell) => cell.thinkingId);
      const generationId = `g:${source.id}`;
      const { model, effort, prompt, messages, budgetUsd, imageSettings } =
        source;
      const attemptId = outputCell ? outputCell.attemptId : source.attemptId;
      let usage = outputCell?.usage;
      if (!usage && outputCell && !attemptId) {
        const call = latestCall.get(outputCell.id) as
          { data: string; cost_usd: number | null } | undefined;
        if (call) {
          const saved = JSON.parse(call.data) as { usage?: Cell["usage"] };
          usage =
            call.cost_usd === null
              ? saved.usage
              : { ...saved.usage, costUsd: call.cost_usd };
        }
      }
      insertTask.run(
        generationId,
        grid.id,
        "generation",
        outputCell ? "complete" : (source.generationStatus ?? source.status),
        null,
        outputCell?.id ?? null,
        traceCell?.id ?? null,
        JSON.stringify({
          input: {
            format: input.format,
            model,
            effort,
            prompt,
            messages,
            budgetUsd,
            imageSettings,
          },
          attemptId,
          ...(!outputCell
            ? { error: source.error, errorCode: source.errorCode }
            : {}),
          ...(outputCell
            ? {
                output: {
                  mediaType: outputCell.mediaType,
                  provenance: outputCell.provenance ?? {
                    signature: "",
                    files: legacyInventory(input.format),
                  },
                  usage,
                  thinkingId: traceCell?.thinkingId,
                },
              }
            : traceCell?.thinkingId ||
                (input.format === "chat-template" && source.draft !== undefined)
              ? {
                  progress: {
                    thinkingId: traceCell?.thinkingId,
                    ...(input.format === "chat-template"
                      ? { draft: source.draft }
                      : {}),
                  },
                }
              : {}),
        }),
      );
      for (const cell of cells) {
        const judgmentId = cell.judge ? `j:${cell.id}` : null;
        if (cell.judge) {
          const {
            model,
            effort,
            status,
            attemptId,
            error,
            errorCode,
            results,
          } = cell.judge;
          const { criteria, images } = resolveLegacyCriteriaForCell(
            input,
            cell.row,
            cell.column,
          );
          insertTask.run(
            judgmentId,
            grid.id,
            "judge",
            status,
            generationId,
            null,
            null,
            JSON.stringify({
              input: {
                model,
                effort,
                criteria,
                ...(images ? { images } : {}),
              },
              attemptId,
              error,
              errorCode,
              ...(results ? { output: { results } } : {}),
            }),
          );
        }
        linkCell.run(generationId, judgmentId, cell.id);
      }
    }
  }
  db.exec(`UPDATE inference_calls SET task_id=(
    SELECT CASE WHEN inference_calls.phase='judge'
      THEN cells.judgment_id ELSE cells.generation_id END
    FROM cells WHERE cells.id=inference_calls.cell_id
  )`);
}
