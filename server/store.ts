import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Grid } from "./domain.js";
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
  constructor(
    path: string,
    private secret: Buffer,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS grids (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, format TEXT NOT NULL, files TEXT NOT NULL);",
    );
    // A process restart must never silently incur another charge.
    for (const g of this.all()) {
      this.indexOutputs(g);
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
      this.db.prepare("SELECT data FROM grids").all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get(id: string): Grid | undefined {
    const row = this.db.prepare("SELECT data FROM grids WHERE id=?").get(id) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  save(grid: Grid) {
    grid.revision = (grid.revision ?? 0) + 1;
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO grids VALUES (?,?)")
        .run(grid.id, JSON.stringify(grid));
      this.indexOutputs(grid);
    })();
  }
  private indexOutputs(grid: Grid) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO outputs VALUES (?,?,?)",
    );
    for (const cell of grid.cells)
      if (cell.status === "complete" && cell.files)
        insert.run(cell.id, grid.input.format, JSON.stringify(cell.files));
  }
  output(
    id: string,
  ):
    | { format: Grid["input"]["format"]; files: Record<string, string> }
    | undefined {
    const row = this.db
      .prepare("SELECT format, files FROM outputs WHERE id=?")
      .get(id) as
      { format: Grid["input"]["format"]; files: string } | undefined;
    return row
      ? { format: row.format, files: JSON.parse(row.files) }
      : undefined;
  }
  session(id: string): Session | undefined {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) return;
    const s: Session = JSON.parse(row.data);
    if (Date.now() - s.created > 30 * 86400000) {
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      return;
    }
    if (s.key) s.key = this.decrypt(s.key);
    return s;
  }
  saveSession(session: Session) {
    this.db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?)").run(
      session.id,
      JSON.stringify({
        ...session,
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
