import type { OAuthAttempt } from "./oauth.js";
import { Billing } from "./billing.js";
import Database from "better-sqlite3";
import { encrypt, decrypt } from "./encryption.js";
import { expandGrid, type Grid, type User, type Identity } from "./domain.js";
import { dirname, join, resolve } from "node:path";
import { OutputFiles } from "./files.js";
import { token } from "./ids.js";
import { migrate } from "./migrations.js";
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
      migrate(this.db);
      this.billing = new Billing(this.db);
      this.files = new OutputFiles(
        resolve(outputsPath ?? join(dirname(path), "outputs")),
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  all(): Grid[] {
    return (
      this.db.prepare("SELECT id FROM grids").all() as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  get(id: string): Grid | undefined {
    const row = this.db.prepare("SELECT data FROM grids WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) return;
    const grid = { ...JSON.parse(row.data), id } as Grid;
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
  save(grid: Grid) {
    grid.revision += 1;
    const { id, cells, ...data } = grid;
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO grids (id, data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(id, JSON.stringify(data));
      const saveCell = this.db.prepare(
        "INSERT INTO cells (id, grid_id, position, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      );
      const hasCalls = this.db.prepare(
        "SELECT 1 FROM inference_calls WHERE cell_id=? LIMIT 1",
      );
      cells.forEach((cell, position) => {
        const recorded = !!hasCalls.get(cell.id);
        const { status, error, errorCode, usage, mediaType } = cell;
        saveCell.run(
          cell.id,
          id,
          position,
          JSON.stringify({
            status,
            error,
            errorCode,
            usage: recorded ? undefined : usage,
            mediaType,
          }),
        );
      });
    })();
  }
  output(
    id: string,
  ): { format: Grid["input"]["format"]; mediaType?: string } | undefined {
    const row = this.db
      .prepare(
        `
      SELECT json_extract(g.data, '$.input.format') AS format,
        json_extract(c.data, '$.mediaType') AS mediaType
      FROM cells c JOIN grids g ON g.id=c.grid_id
      WHERE c.id=? AND json_extract(c.data, '$.status')='complete'
    `,
      )
      .get(id) as
      { format: Grid["input"]["format"]; mediaType: string | null } | undefined;
    return row
      ? { format: row.format, mediaType: row.mediaType ?? undefined }
      : undefined;
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
    if (Date.now() - s.created > 30 * 86400000) {
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      return;
    }
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
        `UPDATE grids SET data=json_set(data, '$.ownerUserId', ?, '$.revision', COALESCE(json_extract(data,'$.revision'),0)+1)
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
