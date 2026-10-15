import { createImageReferences } from "./image-references.js";
import type { OAuthAttempt } from "./oauth.js";
import { publicationError } from "./grid-policy.js";
import { Billing } from "./billing.js";
import Database from "better-sqlite3";
import { encrypt, decrypt } from "./encryption.js";
import {
  expandGrid,
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
      const missingTitle =
        "json_type(data, '$.expanded_prompt_for_title') IS NULL";
      // Avoid taking the writer lock when an existing database needs no backfill.
      if (
        this.db
          .prepare(`SELECT 1 FROM grids WHERE ${missingTitle} LIMIT 1`)
          .get()
      )
        this.db.exec(`UPDATE grids SET data=json_set(data,
          '$.expanded_prompt_for_title', json_extract(data, '$.input.prompt'))
          WHERE ${missingTitle}`);
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
    const row = this.db.prepare("SELECT data FROM grids WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) return;
    const grid = { ...JSON.parse(row.data), id } as StoredGrid;
    if (!grid.title) delete grid.title;
    if (!grid.interruption) delete grid.interruption;
    const cells = this.db
      .prepare("SELECT id, data FROM cells WHERE grid_id=? ORDER BY position")
      .all(id) as { id: string; data: string }[];
    grid.cells = expandGrid(grid.input).map((cell, index) => ({
      ...cell,
      ...JSON.parse(cells[index].data),
      id: cells[index].id,
      ...this.billing.cell(cells[index].id),
    }));
    return grid;
  }
  // Creation is the only operation that writes both metadata and generation state.
  insert(grid: Grid) {
    const { id, cells, ...data } = grid;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO grids (id, data) VALUES (?,?)").run(
        id,
        JSON.stringify({
          ...data,
          expanded_prompt_for_title: expandPromptForTitle(grid.input),
        }),
      );
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
        } = cell;
        saveCell.run(
          JSON.stringify({
            status,
            error,
            errorCode,
            usage: hasCalls.get(cell.id) ? undefined : usage,
            mediaType,
            thinkingId,
            provenance,
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
  publish(id: string, visibility: Grid["visibility"], author: Grid["author"]) {
    // Serialize the terminal-state check with engine writes and retry admission.
    return this.db
      .transaction(() => {
        const grid = this.get(id)!;
        const error = publicationError(grid, visibility);
        if (error || visibility === grid.visibility) return error;
        this.db
          .prepare(
            `UPDATE grids SET data=json_set(data, '$.published', json('true'), '$.visibility', ?, '$.author', json(?)) WHERE id=?`,
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
        `SELECT g.data AS grid, c.data AS cell
      FROM cells c JOIN grids g ON g.id=c.grid_id WHERE c.id=?
    `,
      )
      .get(id) as { grid: string; cell: string } | undefined;
    if (!row) return;
    const { owner, ownerUserId, published, input } = JSON.parse(
      row.grid,
    ) as Grid;
    const { status, mediaType, thinkingId } = JSON.parse(row.cell) as Cell;
    return {
      owner,
      ownerUserId,
      published,
      format: input.format,
      thinkingId,
      status,
      mediaType,
    };
  }
  outputDownload(id: string) {
    const row = this.db
      .prepare(
        `SELECT g.id AS gridId, g.data, c.position,
          json_extract(c.data, '$.mediaType') AS mediaType
         FROM cells c JOIN grids g ON g.id=c.grid_id
         WHERE c.id=? AND json_extract(c.data, '$.status')='complete'`,
      )
      .get(id) as
      | {
          gridId: string;
          data: string;
          position: number;
          mediaType: string | null;
        }
      | undefined;
    if (!row) return;
    const { input } = JSON.parse(row.data) as Pick<Grid, "input">;
    const columns = input.columns.values.length;
    return {
      gridId: row.gridId,
      prompt: input.prompt,
      row: input.rows.values[Math.floor(row.position / columns)],
      column: input.columns.values[row.position % columns],
      format: input.format,
      mediaType: row.mediaType ?? undefined,
    };
  }
  session(id: string): Session | undefined {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) return;
    const s: Session = { ...JSON.parse(row.data), id };
    if (s.key) s.key = decrypt(s.key, this.secret);
    return s;
  }
  saveSession(session: Session) {
    const { id, ...data } = session;
    this.db
      .prepare("INSERT OR REPLACE INTO sessions (id, data) VALUES (?,?)")
      .run(
        id,
        JSON.stringify({
          ...data,
          key: session.key ? encrypt(session.key, this.secret) : undefined,
        }),
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
        `UPDATE grids SET data=json_set(data, '$.ownerUserId', ?)
      WHERE json_extract(data,'$.owner')=? AND json_extract(data,'$.ownerUserId') IS NULL`,
      )
      .run(userId, anonymousId);
  }
  sessionForOwner(owner: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM sessions WHERE id=? OR json_extract(data,'$.anonymousId')=? ORDER BY json_extract(data,'$.created') DESC LIMIT 1",
      )
      .get(owner, owner) as { id: string } | undefined;
    return row ? this.session(row.id) : undefined;
  }
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
}
