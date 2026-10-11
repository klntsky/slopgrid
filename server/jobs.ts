import { join } from "node:path";
import { WebsitePreviews } from "./website-previews.js";
import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import { Provider } from "./provider.js";
import { failureDetails } from "./failures.js";

export class Jobs {
  readonly previews: WebsitePreviews;
  active = new Map<string, Grid>();
  listeners = new Map<string, Set<(grid: Grid) => void>>();
  private running = new Map<
    string,
    { grid: Grid; cell: Cell; controller: AbortController }
  >();
  private workersByOwner = new Map<string, number>();
  private concurrencyByOwner = new Map<string, number>();
  private lastAllocation = new Map<string, number>();
  private draftEmittedAt = new Map<string, number>();
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private allocation = 0;
  private scheduled = false;
  private retries = new Map<string, number>();
  private cooldowns = new Map<string, number>();
  private wake?: ReturnType<typeof setTimeout>;
  constructor(
    private store: Store,
    private provider: Provider,
    readonly workersMax = 100,
  ) {
    if (!Number.isSafeInteger(workersMax) || workersMax < 1)
      throw new Error("WORKERS_MAX must be a positive safe integer");
    this.previews = new WebsitePreviews(join(store.files.root, ".previews"));
  }
  emit(grid: Grid) {
    const timer = this.draftTimers.get(grid.id);
    if (timer) clearTimeout(timer);
    this.draftTimers.delete(grid.id);
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
    this.concurrencyByOwner.set(
      grid.owner,
      this.store.session(grid.owner)?.inferenceConcurrency ?? this.workersMax,
    );
    for (const cell of g.cells)
      if (cell.status !== "complete" && cell.status !== "running") {
        cell.status = "pending";
        delete cell.error;
        delete cell.errorCode;
        delete cell.retrying;
        this.retries.delete(cell.id);
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
    for (const cell of g.cells) {
      this.previews.clear(cell);
      this.retries.delete(cell.id);
      if (cell.retrying) {
        delete cell.retrying;
        delete cell.error;
        delete cell.errorCode;
      }
    }
    for (const { grid: runningGrid, cell, controller } of this.running.values())
      if (runningGrid.id === g.id) {
        cell.status = "pending";
        delete cell.draft;
        delete cell.error;
        delete cell.errorCode;
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
    if (this.wake) clearTimeout(this.wake);
    this.wake = undefined;
    const now = Date.now();
    for (const [owner, until] of this.cooldowns)
      if (until <= now) this.cooldowns.delete(owner);
    if (this.cooldowns.size) {
      const until = Math.min(...this.cooldowns.values());
      this.wake = setTimeout(
        () => this.schedule(),
        Math.min(2_147_483_647, Math.max(1, until - now)),
      );
      this.wake.unref?.();
    }
    while (this.running.size < this.workersMax) {
      let next: { grid: Grid; cell: Cell } | undefined;
      for (const grid of this.active.values()) {
        if (
          grid.status !== "running" ||
          (this.cooldowns.get(grid.owner) ?? 0) > now ||
          (this.workersByOwner.get(grid.owner) ?? 0) >=
            (this.concurrencyByOwner.get(grid.owner) ?? this.workersMax)
        )
          continue;
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
      delete cell.completions;
      delete cell.usage;
      delete cell.error;
      delete cell.errorCode;
      delete cell.retrying;
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
        for (const cell of grid.cells) delete cell.retrying;
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
    ) {
      this.lastAllocation.delete(grid.owner);
      this.concurrencyByOwner.delete(grid.owner);
    }
  }
  private previewUpdated(grid: Grid) {
    const delay = Math.max(
      0,
      300 - (Date.now() - (this.draftEmittedAt.get(grid.id) ?? 0)),
    );
    if (!delay) {
      this.draftEmittedAt.set(grid.id, Date.now());
      this.emit(grid);
    } else if (!this.draftTimers.has(grid.id)) {
      this.draftTimers.set(
        grid.id,
        setTimeout(() => {
          this.draftTimers.delete(grid.id);
          this.draftEmittedAt.set(grid.id, Date.now());
          this.emit(grid);
        }, delay),
      );
    }
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
          if (grid.input.format === "html") {
            this.previews.update(cell, text, () => this.previewUpdated(grid));
            return;
          }
          const now = Date.now();
          if (now - (this.draftEmittedAt.get(grid.id) ?? 0) > 300) {
            this.draftEmittedAt.set(grid.id, now);
            this.emit(grid);
          }
        },
        controller.signal,
        (completion, usage) => {
          if (controller.signal.aborted) return;
          cell.completions = [...(cell.completions ?? []), completion];
          cell.usage = usage;
        },
        this.store.billing.observe(cell.id),
      );
      if (controller.signal.aborted) return;
      this.store.files.write(cell.id, result.files);
      cell.mediaType = result.mediaType;
      cell.usage = result.usage;
      cell.completions = result.completions;
      cell.status = "complete";
      this.retries.delete(cell.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = failureDetails(error);
      cell.error = failure.message;
      cell.errorCode = failure.code;
      const attempt = this.retries.get(cell.id) ?? 0;
      if (failure.temporary && attempt < 5) {
        cell.status = "pending";
        if (grid.status === "running") {
          cell.retrying = true;
          this.retries.set(cell.id, attempt + 1);
          const delay = Math.max(
            failure.retryAfterMs ?? 0,
            Math.min(30_000, 1000 * 2 ** attempt * (1 + Math.random() * 0.5)),
          );
          this.cooldowns.set(
            grid.owner,
            Math.max(this.cooldowns.get(grid.owner) ?? 0, Date.now() + delay),
          );
        }
      } else if (
        !failure.temporary &&
        (failure.status === 402 ||
          failure.status === 401 ||
          failure.status === 403)
      ) {
        cell.status = "pending";
        this.retries.delete(cell.id);
        this.pauseOwner(
          grid.owner,
          failure.status === 402 ? "billing" : "auth",
        );
      } else {
        cell.status = "error";
        this.retries.delete(cell.id);
        console.error(
          "Generation failed",
          grid.id,
          cell.id,
          failure.code ?? (error instanceof Error ? error.name : "unknown"),
        );
      }
    } finally {
      this.previews.clear(cell);
      const billing = this.store.billing.cell(cell.id);
      if (billing) Object.assign(cell, billing);
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
