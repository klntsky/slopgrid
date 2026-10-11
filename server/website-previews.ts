import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cell } from "./domain.js";
import { OutputFiles } from "./files.js";
import { PartialWebsite } from "./partial-website.js";
import { token } from "./ids.js";

type Preview = {
  attempt: string;
  parser: PartialWebsite;
  revision: number;
  at: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class WebsitePreviews {
  private entries = new Map<string, Preview>();
  private files: OutputFiles;
  constructor(readonly root: string) {
    this.files = new OutputFiles(root);
  }
  update(cell: Cell, source: string, notify: () => void) {
    if (!source) {
      const visible = !!cell.preview;
      this.clear(cell);
      if (visible) notify();
      return;
    }
    let entry = this.entries.get(cell.id);
    if (!entry) {
      entry = {
        attempt: token(),
        parser: new PartialWebsite(),
        revision: 0,
        at: 0,
      };
      this.entries.set(cell.id, entry);
    }
    if (!entry.parser.update(source) || !entry.parser.files["index.html"])
      return;
    const current = entry;
    const flush = () => {
      current.timer = undefined;
      if (this.entries.get(cell.id) !== current || cell.status !== "running")
        return;
      for (const path of current.parser.changed) {
        const content = current.parser.files[path];
        const file = join(this.root, current.attempt, path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + ".pending";
        writeFileSync(temporary, content, { mode: 0o600 });
        renameSync(temporary, file);
      }
      current.parser.changed.clear();
      current.at = Date.now();
      cell.preview = { attempt: current.attempt, revision: ++current.revision };
      notify();
    };
    const delay = Math.max(0, 750 - (Date.now() - current.at));
    if (!delay && !current.timer) flush();
    else if (!current.timer) current.timer = setTimeout(flush, delay);
  }
  path(cellId: string, path: string): string | undefined {
    const entry = this.entries.get(cellId);
    if (!entry?.revision) return;
    if (path.startsWith("__preview/")) {
      const prefix = `__preview/${entry.attempt}/`;
      if (!path.startsWith(prefix)) return;
      path = path.slice(prefix.length);
    }
    return this.files.path(entry.attempt, path);
  }
  clear(cell: Cell) {
    const entry = this.entries.get(cell.id);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(cell.id);
      rmSync(join(this.root, entry.attempt), { recursive: true, force: true });
    }
    delete cell.preview;
  }
  clearAll() {
    for (const entry of this.entries.values())
      if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
}
