import type { Grid } from "./domain.js";
import type { Store } from "./store.js";
import { Provider, interruption } from "./provider.js";
export class Jobs {
  active = new Map<string, Grid>();
  listeners = new Map<string, Set<(grid: Grid) => void>>();
  constructor(
    private store: Store,
    private provider: Provider,
  ) {}
  emit(grid: Grid) {
    this.store.save(grid);
    for (const callback of this.listeners.get(grid.id) ?? []) callback(grid);
  }
  subscribe(id: string, callback: (grid: Grid) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(callback);
    this.listeners.set(id, set);
    return () => {
      set.delete(callback);
      if (!set.size) this.listeners.delete(id);
    };
  }
  start(grid: Grid) {
    if (this.active.has(grid.id)) return;
    this.active.set(grid.id, grid);
    grid.status = "running";
    delete grid.interruption;
    this.emit(grid);
    void this.run(grid).finally(() => this.active.delete(grid.id));
  }
  private async run(grid: Grid) {
    for (const cell of grid.cells) {
      if (cell.status === "complete") continue;
      const key = this.store.session(grid.owner)?.key;
      if (!key) {
        grid.status = "paused";
        grid.interruption = "auth";
        this.emit(grid);
        return;
      }
      cell.status = "running";
      delete cell.error;
      delete cell.draft;
      this.emit(grid);
      let last = 0;
      try {
        const result = await this.provider.generate(
          key,
          grid.input.format,
          cell,
          (text) => {
            cell.draft = text;
            if (Date.now() - last > 300) {
              last = Date.now();
              this.emit(grid);
            }
          },
        );
        cell.files = result.files;
        cell.usage = result.usage;
        cell.status = "complete";
        delete cell.draft;
      } catch (error) {
        const reason = interruption(error);
        if (reason) {
          cell.status = "pending";
          grid.status = "paused";
          grid.interruption = reason;
          delete cell.draft;
          this.emit(grid);
          return;
        }
        cell.status = "error";
        cell.error =
          "This cell could not be generated. Retry unfinished cells.";
        delete cell.draft;
        // Provider messages may include credentials or generated content; do not expose them.
        console.error(
          "Generation failed",
          grid.id,
          cell.id,
          error instanceof Error ? error.name : "unknown",
        );
      }
      this.emit(grid);
    }
    grid.status = grid.cells.every((c) => c.status === "complete")
      ? "complete"
      : "paused";
    this.emit(grid);
  }
}
