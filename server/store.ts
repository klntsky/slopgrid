import { createImageReferences } from "./image-references.js";
import type { OAuthAttempt } from "./oauth.js";
import { publicationError } from "./grid-policy.js";
import { Billing } from "./billing.js";
import type Database from "better-sqlite3";
import { encrypt, decrypt } from "./encryption.js";
import {
  isGridFinished,
  type Grid,
  type StoredGrid,
  type ValidatedGridInput,
  type Cell,
  type WorkflowTask,
  type User,
  type Identity,
} from "./domain.js";
import { dirname, join, resolve } from "node:path";
import { OutputFiles } from "./files.js";
import { token } from "./ids.js";
import { openStartupDatabase, type StoreOpenOptions } from "./startup-data-migration.js";
import { expandPromptForTitle } from "./grid-title.js";
import { selectedReferences } from "./image-settings.js";
import { projectWorkflow } from "./workflow.js";
import {
  gridDimensions,
  gridDisplay,
  gridInputText,
} from "../shared/grid-display.js";
export type Session = {
  id: string;
  anonymousId?: string;
  userId?: string;
  identityOAuth?: OAuthAttempt;
  keyOAuth?: OAuthAttempt;
  key?: string;
  inferenceConcurrency?: number;
  created: number;
};
type WorkflowRow = {
  id: string;
  kind: WorkflowTask["kind"];
  status: WorkflowTask["status"];
  dependency_id: string | null;
  artifact_id: string | null;
  thinking_source_id: string | null;
  data: string;
};
function readTask(row: WorkflowRow): WorkflowTask {
  const task = {
    ...JSON.parse(row.data),
    id: row.id,
    kind: row.kind,
    status: row.status,
  } as WorkflowTask;
  if (task.kind === "judge") {
    task.generationId = row.dependency_id!;
  } else {
    if (row.artifact_id)
      task.output = { ...task.output!, artifactId: row.artifact_id };
    if (row.thinking_source_id) {
      if (task.output?.thinkingId)
        task.output.thinkingSourceId = row.thinking_source_id;
      if (task.progress?.thinkingId)
        task.progress.thinkingSourceId = row.thinking_source_id;
    }
  }
  return task;
}
export class Store {
  db: Database.Database;
  files: OutputFiles;
  billing: Billing;
  references: ReturnType<typeof createImageReferences>;
  private constructor(
    db: Database.Database,
    private secret: Buffer,
    outputsPath: string,
  ) {
    this.db = db;
    try {
      this.files = new OutputFiles(outputsPath, (id) => this.artifactReferenced(id));
      this.billing = new Billing(this.db);
      this.references = createImageReferences(this.db, this.files);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  static async open(
    path: string,
    secret: Buffer,
    outputsPath?: string,
    options?: StoreOpenOptions,
  ): Promise<Store> {
    if (path === ":memory:" && !outputsPath)
      throw new Error("An output directory is required for an in-memory database");
    const root = resolve(outputsPath ?? join(dirname(path), "outputs"));
    const database = path === ":memory:" ? path : resolve(path);
    return new Store(await openStartupDatabase(database, root, options), secret, root);
  }
  all(): StoredGrid[] {
    return (
      this.db.prepare("SELECT id FROM grids").all() as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  nextGenerationEpoch(): number {
    return (
      this.db
        .prepare(
          "UPDATE generation_clock SET epoch=epoch+1 WHERE id=1 RETURNING epoch",
        )
        .get() as { epoch: number }
    ).epoch;
  }
  get(id: string): StoredGrid | undefined {
    const row = this.db
      .prepare(
        `SELECT data, owner, owner_user_id AS ownerUserId, published,
          visibility, slug, created_at AS createdAt FROM grids WHERE id=?`,
      )
      .get(id) as
      | {
          data: string;
          owner: string;
          ownerUserId: string | null;
          published: number;
          visibility: Grid["visibility"];
          slug: string | null;
          createdAt: string;
        }
      | undefined;
    if (!row) return;
    const grid = {
      ...JSON.parse(row.data),
      id,
      owner: row.owner,
      ownerUserId: row.ownerUserId ?? undefined,
      published: row.published === 1,
      visibility: row.visibility,
      slug: row.slug ?? undefined,
      createdAt: row.createdAt,
    } as StoredGrid;
    if (row.ownerUserId === null) delete grid.ownerUserId;
    if (row.slug === null) delete grid.slug;
    if (!grid.title) delete grid.title;
    if (!grid.interruption) delete grid.interruption;
    grid.input = this.references.input(grid.input);
    const cells = this.db
      .prepare(
        "SELECT id, position, generation_id, judgment_id FROM cells WHERE grid_id=? ORDER BY position",
      )
      .all(id) as {
      id: string;
      position: number;
      generation_id: string;
      judgment_id: string | null;
    }[];
    const tasks = this.workflow(id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const { columns } = gridDimensions(grid.input);
    grid.cells = cells.map((cell) => {
      const generation = byId.get(cell.generation_id);
      if (generation?.kind !== "generation")
        throw new Error("A cell must reference its generation task.");
      const { format: _format, ...parameters } = generation.input;
      return {
        ...parameters,
        id: cell.id,
        row: Math.floor(cell.position / columns),
        column: cell.position % columns,
        generationId: cell.generation_id,
        judgmentId: cell.judgment_id ?? undefined,
        status: generation.status,
      };
    });
    projectWorkflow(grid, tasks);
    return grid;
  }
  // Creation is the only operation that writes both metadata and generation state.
  insert(
    grid: Grid & { input: ValidatedGridInput },
    tasks: readonly WorkflowTask[],
  ) {
    grid.input = this.references.input(grid.input);
    for (const task of tasks) this.references.task(task);
    projectWorkflow(grid, tasks);
    const {
      id,
      cells,
      owner,
      ownerUserId,
      published,
      visibility,
      slug,
      createdAt,
      ...data
    } = grid;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO grids
            (id, data, owner, owner_user_id, published, visibility, slug, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          JSON.stringify({
            ...data,
            expanded_prompt_for_title: expandPromptForTitle(grid.input),
          }),
          owner,
          ownerUserId ?? null,
          published ? 1 : 0,
          visibility,
          slug ?? null,
          createdAt,
        );
      const referenceIds = new Set(
        selectedReferences(grid.input).map((reference) => reference.id),
      );
      if (referenceIds.size) {
        const insertReference = this.db.prepare(
          "INSERT INTO grid_reference_images (grid_id, reference_id) VALUES (?,?)",
        );
        for (const referenceId of referenceIds)
          insertReference.run(id, referenceId);
      }
      this.saveWorkflow(grid, tasks);
      const insert = this.db.prepare(
        "INSERT INTO cells (id, grid_id, position, data, generation_id, judgment_id) VALUES (?,?,?,'{}',?,?)",
      );
      cells.forEach((cell, position) =>
        insert.run(
          cell.id,
          id,
          position,
          cell.generationId,
          cell.judgmentId ?? null,
        ),
      );
    })();
  }
  workflow(gridId: string): WorkflowTask[] {
    const rows = this.db
      .prepare(
        "SELECT id,kind,status,dependency_id,artifact_id,thinking_source_id,data FROM workflow_tasks WHERE grid_id=? ORDER BY rowid",
      )
      .all(gridId) as WorkflowRow[];
    return rows.map((row) => {
      const task = readTask(row);
      this.references.task(task);
      if (task.kind === "generation" && (task.attemptId || !task.output)) {
        const billing = this.billing.task(task.id, task.attemptId);
        if (billing) {
          if (task.output) task.output.usage = billing.usage;
          else task.progress = { ...task.progress, usage: billing.usage };
        }
      }
      return task;
    });
  }
  saveWorkflow(grid: Grid, tasks: readonly WorkflowTask[]) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE grids SET data=json_set(data, '$.status', ?, '$.interruption', json(?)) WHERE id=?`,
        )
        .run(grid.status, JSON.stringify(grid.interruption ?? null), grid.id);
      const save = this.db.prepare(
        `INSERT INTO workflow_tasks
          (id,grid_id,kind,status,dependency_id,artifact_id,thinking_source_id,data)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            kind=excluded.kind,status=excluded.status,
            dependency_id=excluded.dependency_id,artifact_id=excluded.artifact_id,
            thinking_source_id=excluded.thinking_source_id,data=excluded.data
          WHERE workflow_tasks.grid_id=excluded.grid_id`,
      );
      for (const task of tasks) {
        this.references.task(task);
        let output: unknown = task.output;
        let artifactId: string | undefined;
        let thinkingSourceId: string | undefined;
        let progress: { thinkingId?: string; draft?: string } | undefined;
        if (task.kind === "generation") {
          if (task.status === "complete" && !task.output?.artifactId)
            throw new Error(
              "A completed generation must reference an artifact.",
            );
          if (task.output) {
            const {
              artifactId: artifact,
              thinkingSourceId: thinkingSource,
              ...result
            } = task.output;
            artifactId = artifact;
            thinkingSourceId = thinkingSource;
            output = result;
          }
          thinkingSourceId =
            task.progress?.thinkingSourceId ?? thinkingSourceId;
          if (
            task.progress?.thinkingId ||
            (task.input.format === "chat-template" &&
              task.status !== "complete" &&
              task.progress?.draft !== undefined)
          )
            progress = {
              thinkingId: task.progress.thinkingId,
              draft:
                task.input.format === "chat-template" &&
                task.status !== "complete"
                  ? task.progress.draft
                  : undefined,
            };
        }
        const changed = save.run(
          task.id,
          grid.id,
          task.kind,
          task.status,
          task.kind === "judge" ? task.generationId : null,
          artifactId ?? null,
          thinkingSourceId ?? null,
          JSON.stringify({
            input: task.input,
            output,
            attemptId: task.attemptId,
            error: task.error,
            errorCode: task.errorCode,
            progress,
          }),
        );
        if (!changed.changes)
          throw new Error("A workflow task cannot change grids.");
      }
    })();
  }
  artifactReferenced(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM workflow_tasks WHERE artifact_id=? OR thinking_source_id=? LIMIT 1",
      )
      .get(id, id);
  }
  removeUnreferencedArtifact(id: string): boolean {
    return this.db.transaction(() => this.files.removeArtifact(id)).immediate();
  }
  setTitle(id: string, title: string) {
    this.db
      .prepare(
        `UPDATE grids SET data=json_set(data, '$.title', json(?)) WHERE id=?`,
      )
      .run(JSON.stringify(title || null), id);
  }
  gridIdBySlug(slug: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM grids WHERE slug=? AND visibility='public'")
      .get(slug) as { id: string } | undefined;
    return row?.id;
  }
  publish(
    id: string,
    visibility: Grid["visibility"],
    author: Grid["author"],
    slug?: string,
  ) {
    // Serialize publication eligibility with engine writes and retry admission.
    return this.db
      .transaction(() => {
        const grid = this.get(id)!;
        if (slug !== undefined && isGridFinished(grid))
          return "Finished grids allow only title and visibility changes.";
        const error = publicationError(grid, visibility);
        if (error) return error;
        if (slug && visibility !== "public")
          return "Only public grids can claim a slug.";
        if (grid.slug && slug !== undefined && slug !== grid.slug)
          return "A claimed slug cannot be changed or removed.";
        if (slug) {
          const claimed = this.gridIdBySlug(slug);
          if (claimed && claimed !== id) return "This slug is already claimed.";
        }
        if (slug && !grid.slug)
          this.db.prepare("UPDATE grids SET slug=? WHERE id=?").run(slug, id);
        if (visibility === grid.visibility) return;
        this.db
          .prepare(
            `UPDATE grids SET published=1, visibility=?, data=json_set(data, '$.author', json(?)) WHERE id=?`,
          )
          .run(
            visibility,
            JSON.stringify(
              grid.published ? (grid.author ?? null) : (author ?? null),
            ),
            id,
          );
      })
      .immediate();
  }
  outputMetadata(id: string) {
    const row = this.db
      .prepare(
        `SELECT g.owner, g.owner_user_id AS ownerUserId, g.published,
          g.data AS grid, generation.status, generation.artifact_id AS artifactId,
          generation.thinking_source_id AS thinkingSourceId,
          c.generation_id AS generationId,
          generation.data AS generation, judgment.status AS judgmentStatus
        FROM cells c JOIN grids g ON g.id=c.grid_id
        JOIN workflow_tasks generation ON generation.id=c.generation_id
        LEFT JOIN workflow_tasks judgment ON judgment.id=c.judgment_id
        WHERE c.id=?`,
      )
      .get(id) as
      | {
          owner: string;
          ownerUserId: string | null;
          published: number;
          grid: string;
          status: Cell["status"];
          generationId: string;
          artifactId: string | null;
          thinkingSourceId: string | null;
          generation: string;
          judgmentStatus: Cell["status"] | null;
        }
      | undefined;
    if (!row) return;
    const { input } = JSON.parse(row.grid) as Pick<Grid, "input">;
    const generation = JSON.parse(row.generation) as Pick<
      Extract<WorkflowTask, { kind: "generation" }>,
      "input" | "output" | "progress"
    >;
    return {
      owner: row.owner,
      ownerUserId: row.ownerUserId ?? undefined,
      published: row.published === 1,
      format: input.format,
      generationId: row.generationId,
      thinkingId:
        generation.progress?.thinkingId ?? generation.output?.thinkingId,
      thinkingSourceId: row.thinkingSourceId ?? undefined,
      artifactId: row.artifactId ?? undefined,
      status:
        row.status === "complete" && row.artifactId
          ? (row.judgmentStatus ?? "complete")
          : row.status,
      outputReady: !!row.artifactId,
      mediaType: generation.output?.mediaType,
    };
  }
  outputDownload(id: string) {
    const output = this.outputMetadata(id);
    if (!output?.outputReady) return;
    const row = this.db
      .prepare(
        `SELECT g.id AS gridId, g.data, c.position
         FROM cells c JOIN grids g ON g.id=c.grid_id WHERE c.id=?`,
      )
      .get(id) as { gridId: string; data: string; position: number };
    const { input } = JSON.parse(row.data) as Pick<Grid, "input">;
    const { columns } = gridDimensions(input);
    const display = gridDisplay(input);
    return {
      gridId: row.gridId,
      prompt: gridInputText(input),
      row: display.rows[Math.floor(row.position / columns)].downloadLabel,
      column: display.columns[row.position % columns].downloadLabel,
      format: input.format,
      mediaType: output.mediaType,
      artifactId: output.artifactId!,
      thinkingSourceId: output.thinkingSourceId,
    };
  }
  session(id: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT data, anonymous_id AS anonymousId, created_at AS createdAt FROM sessions WHERE id=?",
      )
      .get(id) as
      | { data: string; anonymousId: string | null; createdAt: number }
      | undefined;
    if (!row) return;
    const s: Session = {
      ...JSON.parse(row.data),
      id,
      anonymousId: row.anonymousId ?? undefined,
      created: row.createdAt,
    };
    if (row.anonymousId === null) delete s.anonymousId;
    if (s.key) s.key = decrypt(s.key, this.secret);
    return s;
  }
  saveSession(session: Session) {
    const { id, anonymousId, created, ...data } = session;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sessions (id, data, anonymous_id, created_at) VALUES (?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify({
          ...data,
          key: session.key ? encrypt(session.key, this.secret) : undefined,
        }),
        anonymousId ?? null,
        created,
      );
  }
  user(id: string): User | undefined {
    const row = this.db.prepare("SELECT data FROM users WHERE id=?").get(id) as
      { data: string } | undefined;
    return row ? { ...JSON.parse(row.data), id } : undefined;
  }
  identify(provider: string, subject: string, identity: Identity): User {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT user_id FROM oauth_identities WHERE provider=? AND subject=?",
        )
        .get(provider, subject) as { user_id: string } | undefined;
      const id = existing?.user_id ?? token();
      this.db
        .prepare(
          "INSERT INTO users (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(id, JSON.stringify(identity));
      if (!existing)
        this.db
          .prepare(
            "INSERT INTO oauth_identities (provider,subject,user_id) VALUES (?,?,?)",
          )
          .run(provider, subject, id);
      return { ...identity, id };
    })();
  }
  claim(anonymousId: string, userId: string) {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE reference_images SET owner_user_id=? WHERE owner=? AND owner_user_id IS NULL",
          )
          .run(userId, anonymousId);
        this.db
          .prepare(
            `UPDATE grids SET owner_user_id=?
        WHERE owner=? AND owner_user_id IS NULL`,
          )
          .run(userId, anonymousId);
        this.db
          .prepare(
            `INSERT INTO grid_favorites (user_id,grid_id)
        SELECT ?,grid_id FROM anonymous_grid_favorites WHERE anonymous_id=?
        ON CONFLICT(user_id,grid_id) DO NOTHING`,
          )
          .run(userId, anonymousId);
        this.db
          .prepare("DELETE FROM anonymous_grid_favorites WHERE anonymous_id=?")
          .run(anonymousId);
      })
      .immediate();
  }
  sessionForOwner(owner: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM sessions WHERE id=? OR anonymous_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(owner, owner) as { id: string } | undefined;
    return row ? this.session(row.id) : undefined;
  }
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
}
