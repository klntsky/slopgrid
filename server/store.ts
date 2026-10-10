import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { expandGrid, type Grid } from "./domain.js";
import { dirname, join, resolve } from "node:path";
import { OutputFiles } from "./files.js";
import { migrate } from "./migrations.js";
export type Session = {
  id: string;
  key?: string;
  verifier?: string;
  state?: string;
  oauthAt?: number;
  returnTo?: string;
  created: number;
};
export class Store {
  db: Database.Database;
  files: OutputFiles;
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
      this.files = new OutputFiles(
        resolve(outputsPath ?? join(dirname(path), "outputs")),
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
    // A process restart must never silently incur another charge.
    for (const g of this.all()) {
      if (g.status === "running") {
        g.status = "paused";
        g.interruption = "restart";
        for (const c of g.cells)
          if (c.status === "running") c.status = "pending";
        this.save(g);
      }
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
      cells.forEach((cell, position) => {
        const { status, error, errorCode, usage, mediaType } = cell;
        saveCell.run(
          cell.id,
          id,
          position,
          JSON.stringify({ status, error, errorCode, usage, mediaType }),
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
    if (s.key) s.key = this.decrypt(s.key);
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
          key: session.key ? this.encrypt(session.key) : undefined,
        }),
      );
  }
  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secret, iv);
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private decrypt(value: string) {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.secret,
      data.subarray(0, 12),
    );
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([
      cipher.update(data.subarray(12, -16)),
      cipher.final(),
    ]).toString();
  }
}
