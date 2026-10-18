import { createImageReferences } from "./image-references.js";
import type { OAuthAttempt } from "./oauth.js";
import { publicationError } from "./grid-policy.js";
import { Billing } from "./billing.js";
import Database from "better-sqlite3";
import { encrypt, decrypt } from "./encryption.js";
import {
  expandGrid,
  hasCompletedOutput,
  type Grid,
  type StoredGrid,
  type Cell,
  type User,
  type Identity,
} from "./domain.js";
import { dirname, join, resolve } from "node:path";
import { OutputFiles } from "./files.js";
import { token } from "./ids.js";
import { initializeDatabase } from "./database.js";
import { expandPromptForTitle } from "./grid-title.js";
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
export class Store {
  db: Database.Database;
  files: OutputFiles;
  billing: Billing;
  references: ReturnType<typeof createImageReferences>;
  constructor(
    path: string,
    private secret: Buffer,
    outputsPath?: string,
  ) {
    if (path === ":memory:" && !outputsPath)
      throw new Error(
        "An output directory is required for an in-memory database",
      );
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      initializeDatabase(this.db);
      this.billing = new Billing(this.db);
      this.files = new OutputFiles(
        resolve(outputsPath ?? join(dirname(path), "outputs")),
      );
      this.references = createImageReferences(this.db, this.files);
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    const cells = this.db
      .prepare("SELECT id, data FROM cells WHERE grid_id=? ORDER BY position")
      .all(id) as { id: string; data: string }[];
    grid.cells = expandGrid(grid.input).map((cell, index) => {
      const saved = JSON.parse(cells[index].data) as Cell;
      return {
        ...cell,
        ...saved,
        id: cells[index].id,
        ...(saved.attemptId
          ? this.billing.cell(cells[index].id, saved.attemptId)
          : saved.usage
            ? {}
            : this.billing.cell(cells[index].id)),
      };
    });
    return grid;
  }
  // Creation is the only operation that writes both metadata and generation state.
  insert(grid: Grid) {
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
      if (grid.input.inputReferences || grid.input.referenceGroups) {
        const referenceIds = new Set<string>();
        for (const reference of grid.input.inputReferences ?? [])
          referenceIds.add(reference.id);
        for (const group of Object.values(grid.input.referenceGroups ?? {}))
          for (const reference of group) referenceIds.add(reference.id);
        const insertReference = this.db.prepare(
          "INSERT INTO grid_reference_images (grid_id, reference_id) VALUES (?,?)",
        );
        for (const referenceId of referenceIds)
          insertReference.run(id, referenceId);
      }
      const insert = this.db.prepare(
        "INSERT INTO cells (id, grid_id, position, data) VALUES (?,?,?,?)",
      );
      cells.forEach((cell, position) =>
        insert.run(cell.id, id, position, "{}"),
      );
      this.saveGeneration(grid);
    })();
  }
  saveGeneration(grid: Grid, cells: readonly Cell[] = grid.cells) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE grids SET data=json_set(data, '$.status', ?, '$.interruption', json(?)) WHERE id=?`,
        )
        .run(grid.status, JSON.stringify(grid.interruption ?? null), grid.id);
      const saveCell = this.db.prepare(
        "UPDATE cells SET data=? WHERE id=? AND grid_id=?",
      );
      const hasCalls = this.db.prepare(
        "SELECT 1 FROM inference_calls WHERE cell_id=? LIMIT 1",
      );
      for (const cell of cells) {
        const {
          status,
          error,
          errorCode,
          usage,
          mediaType,
          thinkingId,
          provenance,
          attemptId,
          judge,
          generationSourceId,
          generationStatus,
        } = cell;
        saveCell.run(
          JSON.stringify({
            status,
            error,
            errorCode,
            usage: !attemptId || !hasCalls.get(cell.id) ? usage : undefined,
            ...(grid.input.format === "chat-template" &&
              cell.status !== "complete" && { draft: cell.draft }),
            mediaType,
            thinkingId,
            provenance,
            attemptId,
            judge,
            generationSourceId,
            generationStatus,
          }),
          cell.id,
          grid.id,
        );
      }
    })();
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
        g.data AS grid, c.data AS cell
      FROM cells c JOIN grids g ON g.id=c.grid_id WHERE c.id=?
    `,
      )
      .get(id) as
      | {
          owner: string;
          ownerUserId: string | null;
          published: number;
          grid: string;
          cell: string;
        }
      | undefined;
    if (!row) return;
    const { input } = JSON.parse(row.grid) as Pick<Grid, "input">;
    const cell = JSON.parse(row.cell) as Cell;
    const { status, mediaType, thinkingId } = cell;
    return {
      owner: row.owner,
      ownerUserId: row.ownerUserId ?? undefined,
      published: row.published === 1,
      format: input.format,
      thinkingId,
      status,
      outputReady: hasCompletedOutput(cell),
      mediaType,
    };
  }
  outputDownload(id: string) {
    const row = this.db
      .prepare(
        `SELECT g.id AS gridId, g.data, c.position, c.data AS cell
         FROM cells c JOIN grids g ON g.id=c.grid_id
         WHERE c.id=?`,
      )
      .get(id) as
      | {
          gridId: string;
          data: string;
          position: number;
          cell: string;
        }
      | undefined;
    if (!row) return;
    const cell = JSON.parse(row.cell) as Cell;
    if (!hasCompletedOutput(cell)) return;
    const { input } = JSON.parse(row.data) as Pick<Grid, "input">;
    const columns = input.columns.values.length;
    return {
      gridId: row.gridId,
      prompt: input.prompt,
      row: input.rows.values[Math.floor(row.position / columns)],
      column: input.columns.values[row.position % columns],
      format: input.format,
      mediaType: cell.mediaType,
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
