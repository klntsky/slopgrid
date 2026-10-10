import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import { Provider, interruption } from "./provider.js";

export class Jobs {
  active = new Map<string, Grid>();
  listeners = new Map<string, Set<(grid: Grid) => void>>();
  private running = new Map<
    string,
    { grid: Grid; cell: Cell; controller: AbortController }
  >();
  private workersByOwner = new Map<string, number>();
  private lastAllocation = new Map<string, number>();
  private draftEmittedAt = new Map<string, number>();
  private allocation = 0;
  private scheduled = false;
  constructor(
    private store: Store,
    private provider: Provider,
    readonly workersMax = 100,
  ) {
    if (!Number.isSafeInteger(workersMax) || workersMax < 1)
      throw new Error("WORKERS_MAX must be a positive safe integer");
  }
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
  start(grid: Grid): Grid {
    const current = this.active.get(grid.id);
    if (current?.status === "running") return current;
    const g = current ?? grid;
    for (const cell of g.cells)
      if (cell.status !== "complete" && cell.status !== "running") {
        cell.status = "pending";
        delete cell.error;
        delete cell.draft;
      }
    g.status = "running";
    delete g.interruption;
    this.draftEmittedAt.delete(g.id);
    this.active.set(g.id, g);
    this.emit(g);
    this.schedule();
    return g;
  }
  pause(grid: Grid): Grid {
    const g = this.active.get(grid.id) ?? grid;
    if (g.status === "complete") return g;
    g.status = "paused";
    g.interruption = "manual";
    this.draftEmittedAt.delete(g.id);
    for (const { grid: runningGrid, cell, controller } of this.running.values())
      if (runningGrid.id === g.id) {
        cell.status = "pending";
        delete cell.draft;
        delete cell.error;
        controller.abort();
      }
    this.settle(g);
    this.emit(g);
    this.schedule();
    return g;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.dispatch();
    });
  }
  private dispatch() {
    while (this.running.size < this.workersMax) {
      let next: { grid: Grid; cell: Cell } | undefined;
      for (const grid of this.active.values()) {
        if (grid.status !== "running") continue;
        const cell = grid.cells.find(
          (c) => c.status === "pending" && !this.running.has(c.id),
        );
        if (!cell) continue;
        if (!next || this.precedes(grid.owner, next.grid.owner))
          next = { grid, cell };
      }
      if (!next) return;
      const { grid, cell } = next,
        key = this.store.session(grid.owner)?.key;
      if (!key) {
        this.pauseOwner(grid.owner, "auth");
        continue;
      }
      const controller = new AbortController();
      this.running.set(cell.id, { grid, cell, controller });
      this.workersByOwner.set(
        grid.owner,
        (this.workersByOwner.get(grid.owner) ?? 0) + 1,
      );
      this.lastAllocation.set(grid.owner, ++this.allocation);
      cell.status = "running";
      delete cell.error;
      delete cell.draft;
      this.emit(grid);
      void this.runCell(grid, cell, key, controller);
    }
  }
  private precedes(owner: string, other: string): boolean {
    const count = this.workersByOwner.get(owner) ?? 0,
      otherCount = this.workersByOwner.get(other) ?? 0;
    return (
      count < otherCount ||
      (count === otherCount &&
        (this.lastAllocation.get(owner) ?? 0) <
          (this.lastAllocation.get(other) ?? 0))
    );
  }
  private pauseOwner(owner: string, reason: "billing" | "auth") {
    for (const grid of [...this.active.values()])
      if (grid.owner === owner && grid.status === "running") {
        grid.status = "paused";
        grid.interruption = reason;
        this.settle(grid);
        this.emit(grid);
      }
  }
  private settle(grid: Grid) {
    const inFlight = [...this.running.values()].some(
      (work) => work.grid.id === grid.id,
    );
    if (inFlight) return;
    if (grid.cells.every((cell) => cell.status === "complete")) {
      grid.status = "complete";
      delete grid.interruption;
    } else if (
      grid.status === "running" &&
      !grid.cells.some((cell) => cell.status === "pending")
    )
      grid.status = "paused";
    if (grid.status !== "running") {
      this.active.delete(grid.id);
      this.draftEmittedAt.delete(grid.id);
    }
    if (
      !this.workersByOwner.has(grid.owner) &&
      ![...this.active.values()].some((g) => g.owner === grid.owner)
    )
      this.lastAllocation.delete(grid.owner);
  }
  private async runCell(
    grid: Grid,
    cell: Cell,
    key: string,
    controller: AbortController,
  ) {
    try {
      const result = await this.provider.generate(
        key,
        grid.input.format,
        cell,
        (text) => {
          if (controller.signal.aborted) return;
          cell.draft = text;
          const now = Date.now();
          if (now - (this.draftEmittedAt.get(grid.id) ?? 0) > 300) {
            this.draftEmittedAt.set(grid.id, now);
            this.emit(grid);
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.store.files.write(cell.id, result.files);
      cell.mediaType = result.mediaType;
      cell.usage = result.usage;
      cell.status = "complete";
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = interruption(error);
      if (reason) {
        cell.status = "pending";
        delete cell.draft;
        this.pauseOwner(grid.owner, reason);
      } else {
        cell.status = "error";
        cell.error =
          "This cell could not be generated. Retry unfinished cells.";
        console.error(
          "Generation failed",
          grid.id,
          cell.id,
          error instanceof Error ? error.name : "unknown",
        );
      }
    } finally {
      delete cell.draft;
      this.running.delete(cell.id);
      const remaining = (this.workersByOwner.get(grid.owner) ?? 1) - 1;
      if (remaining) this.workersByOwner.set(grid.owner, remaining);
      else this.workersByOwner.delete(grid.owner);
      this.settle(grid);
      this.emit(grid);
      this.schedule();
    }
  }
}
