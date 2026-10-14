import type { Session } from "./store.js";
import { token } from "./ids.js";
import { join } from "node:path";
import { WebsitePreviews } from "./website-previews.js";
import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import { Provider } from "./provider.js";
import { failureDetails } from "./failures.js";
import { selectWorker } from "./worker-allocation.js";

type GridRuntime = {
  references: ReturnType<Store["references"]["loader"]>;
  owner: string;
  key?: string;
  emittedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class Jobs {
  readonly previews: WebsitePreviews;
  active = new Map<string, Grid>();
  private running = new Map<
    string,
    { grid: Grid; cell: Cell; controller: AbortController; owner: string }
  >();
  private runtime = new Map<string, GridRuntime>();
  private executionOwner(grid: Grid) {
    return this.runtime.get(grid.id)?.owner ?? grid.owner;
  }
  private owners = new Map<string, { limit: number; last: number }>();
  private allocation = 0;
  private scheduled = false;
  private retries = new Map<string, number>();
  private cooldowns = new Map<string, number>();
  private wake?: ReturnType<typeof setTimeout>;
  constructor(
    private store: Store,
    private provider: Provider,
    readonly workersMax = 100,
    private save: (grid: Grid) => void = (grid) => store.saveGeneration(grid),
  ) {
    if (!Number.isSafeInteger(workersMax) || workersMax < 1)
      throw new Error("WORKERS_MAX must be a positive safe integer");
    this.previews = new WebsitePreviews(join(store.files.root, ".previews"));
  }
  private emit(grid: Grid) {
    const state = this.runtime.get(grid.id);
    clearTimeout(state?.timer);
    if (state) delete state.timer;
    this.save(grid);
  }
  draining = false;
  status() {
    return {
      draining: this.draining,
      runningCalls: this.running.size,
      activeGrids: [...this.active.values()].filter(
        (grid) => grid.status === "running",
      ).length,
    };
  }
  snapshot(id: string): Grid | undefined {
    const stored = this.store.get(id);
    if (!stored) return;
    const active = this.active.get(id);
    return active
      ? {
          ...stored,
          status: active.status,
          interruption: active.interruption,
          cells: active.cells,
        }
      : stored;
  }
  start(grid: Grid, key?: string, session?: Session): Grid {
    const current = this.active.get(grid.id);
    if (current?.status === "running") return current;
    const g = current ?? grid;
    const owner = session
      ? (session.anonymousId ?? session.id)
      : this.executionOwner(g);
    clearTimeout(this.runtime.get(g.id)?.timer);
    this.runtime.set(g.id, {
      owner,
      key: key || undefined,
      references: this.store.references.loader(),
    });
    this.owners.set(owner, {
      limit:
        this.store.sessionForOwner(owner)?.inferenceConcurrency ??
        this.workersMax,
      last: this.owners.get(owner)?.last ?? 0,
    });
    for (const cell of g.cells)
      if (cell.status !== "complete" && cell.status !== "running") {
        cell.status = "pending";
        delete cell.error;
        delete cell.errorCode;
        delete cell.retrying;
        this.retries.delete(cell.id);
        delete cell.draft;
        delete cell.thinking;
        delete cell.estimatedUsage;
      }
    g.status = "running";
    delete g.interruption;
    this.active.set(g.id, g);
    this.emit(g);
    this.schedule();
    return g;
  }
  pause(grid: Grid): Grid {
    const g = this.active.get(grid.id) ?? grid;
    if (g.status === "complete") return g;
    g.status = "paused";
    const state = this.runtime.get(g.id);
    if (state) delete state.key;
    g.interruption = "manual";
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
        delete cell.thinking;
        delete cell.estimatedUsage;
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
    for (;;) {
      const candidates = new Map<string, { grid: Grid; cell: Cell }>();
      for (const grid of this.active.values()) {
        const owner = this.executionOwner(grid);
        if (
          grid.status !== "running" ||
          (this.cooldowns.get(owner) ?? 0) > now ||
          candidates.has(owner) ||
          [...this.running.values()].filter((work) => work.grid.id === grid.id)
            .length >= (grid.input.parallelWorkers ?? this.workersMax)
        )
          continue;
        const cell = grid.cells.find(
          (c) => c.status === "pending" && !this.running.has(c.id),
        );
        if (cell) candidates.set(owner, { grid, cell });
      }
      const owner = selectWorker(
        this.owners,
        candidates.keys(),
        [...this.running.values()].map((work) => work.owner),
        this.workersMax,
      );
      if (owner === undefined) return;
      const { grid, cell } = candidates.get(owner)!;
      const key =
        this.runtime.get(grid.id)?.key ??
        this.store.sessionForOwner(owner)?.key;
      const controller = new AbortController();
      this.running.set(cell.id, { grid, cell, controller, owner });
      this.owners.get(owner)!.last = ++this.allocation;
      cell.status = "running";
      delete cell.thinkingId;
      delete cell.usage;
      delete cell.error;
      delete cell.errorCode;
      delete cell.retrying;
      delete cell.draft;
      delete cell.thinking;
      delete cell.estimatedUsage;
      this.emit(grid);
      void this.runCell(grid, cell, key, controller, owner);
    }
  }
  private pauseOwner(owner: string) {
    for (const grid of [...this.active.values()])
      if (this.executionOwner(grid) === owner && grid.status === "running") {
        grid.status = "paused";
        this.runtime.get(grid.id)!.key = undefined;
        grid.interruption = "billing";
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
      clearTimeout(this.runtime.get(grid.id)?.timer);
      this.runtime.delete(grid.id);
    }
    const owners = new Set(
      [...this.active.values()].map((g) => this.executionOwner(g)),
    );
    for (const work of this.running.values()) owners.add(work.owner);
    for (const owner of this.owners.keys())
      if (!owners.has(owner)) this.owners.delete(owner);
  }
  private previewUpdated(grid: Grid) {
    const state = this.runtime.get(grid.id)!;
    const delay = Math.max(0, 300 - (Date.now() - (state.emittedAt ?? 0)));
    const flush = () => {
      if (this.runtime.get(grid.id) !== state) return;
      state.emittedAt = Date.now();
      this.emit(grid);
    };
    if (!delay) flush();
    else if (!state.timer) state.timer = setTimeout(flush, delay);
  }
  private async runCell(
    grid: Grid,
    cell: Cell,
    key: string | undefined,
    controller: AbortController,
    owner: string,
  ) {
    const thinkingId = token();
    const current = () =>
      !controller.signal.aborted &&
      this.running.get(cell.id)?.controller === controller;
    try {
      if (!key) throw new Error("Reconnect OpenRouter to continue.");
      const references = await this.runtime
        .get(grid.id)!
        .references(cell.imageSettings?.input_references ?? []);
      if (!current()) return;
      const result = await this.provider.generate(
        key,
        grid.input.format,
        cell,
        ({ text, thinking, estimatedUsage }) => {
          if (!current()) return;
          // Drafts can be read between throttled SSE emissions. Give each update
          // its own revision so a late HTTP snapshot cannot regress live text.
          this.store.nextRevision(grid);
          const previousLength = cell.thinking?.length ?? 0;
          if (thinking.length > previousLength) {
            this.store.files.appendThinking(
              cell.id,
              thinkingId,
              thinking.slice(previousLength),
            );
            cell.thinkingId = thinkingId;
          }
          cell.thinking = thinking;
          const changed = cell.draft !== text;
          cell.draft = text;
          cell.estimatedUsage = estimatedUsage;
          if (changed && grid.input.format === "html") {
            this.previews.update(cell, text, () => this.previewUpdated(grid));
          }
          this.previewUpdated(grid);
        },
        controller.signal,
        this.store.billing.observe(cell.id),
        references,
      );
      if (!current()) return;
      this.store.files.write(cell.id, result.files);
      cell.mediaType = result.mediaType;
      cell.usage = result.usage;
      cell.provenance = {
        signature: result.signature,
        files: Object.keys(result.files).sort(),
      };
      cell.status = "complete";
      this.retries.delete(cell.id);
    } catch (error) {
      if (!current()) return;
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
            owner,
            Math.max(this.cooldowns.get(owner) ?? 0, Date.now() + delay),
          );
        }
      } else if (failure.billing) {
        cell.status = "pending";
        this.retries.delete(cell.id);
        this.pauseOwner(owner);
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
      delete cell.thinking;
      delete cell.estimatedUsage;
      this.running.delete(cell.id);
      this.settle(grid);
      this.emit(grid);
      this.schedule();
    }
  }
}
