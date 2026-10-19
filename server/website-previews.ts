import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GenerationTask } from "./domain.js";
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
  constructor(
    readonly root: string,
    private persist: (write: () => void) => void = (write) => write(),
  ) {
    this.files = new OutputFiles(root);
  }
  update(
    task: GenerationTask,
    source: string,
    notify: () => void,
    isCurrent: () => boolean,
  ) {
    let entry = this.entries.get(task.id);
    if (!entry) {
      entry = {
        attempt: token(),
        parser: new PartialWebsite(),
        revision: 0,
        at: 0,
      };
      this.entries.set(task.id, entry);
    }
    if (!entry.parser.update(source) || !entry.parser.files["index.html"])
      return;
    const current = entry;
    const flush = () =>
      this.persist(() => {
        current.timer = undefined;
        if (this.entries.get(task.id) !== current || !isCurrent()) return;
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
        (task.progress ??= {}).preview = {
          attempt: current.attempt,
          revision: ++current.revision,
        };
        notify();
      });
    const delay = Math.max(0, 750 - (Date.now() - current.at));
    if (!delay && !current.timer) flush();
    else if (!current.timer) current.timer = setTimeout(flush, delay);
  }
  path(taskId: string, path: string): string | undefined {
    const entry = this.entries.get(taskId);
    if (!entry?.revision) return;
    if (path.startsWith("__preview/")) {
      const prefix = `__preview/${entry.attempt}/`;
      if (!path.startsWith(prefix)) return;
      path = path.slice(prefix.length);
    }
    return this.files.path(entry.attempt, path);
  }
  clear(task: GenerationTask) {
    const entry = this.entries.get(task.id);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(task.id);
      this.persist(() =>
        rmSync(join(this.root, entry.attempt), {
          recursive: true,
          force: true,
        }),
      );
    }
    if (task.progress) delete task.progress.preview;
  }
  clearAll() {
    for (const entry of this.entries.values())
      if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
}
