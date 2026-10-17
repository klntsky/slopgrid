import type { Session } from "./store.js";
import { token } from "./ids.js";
import { join } from "node:path";
import { WebsitePreviews } from "./website-previews.js";
import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import { Provider } from "./provider.js";
import { failureDetails, failureDiagnostics } from "./failures.js";
import { selectWorker } from "./worker-allocation.js";
import { Persistence } from "./persistence.js";
import { generationFailure } from "./generation-api.js";
import { generateAttempt, type AttemptResult } from "./generation-attempt.js";
import {
  beginCellAttempt,
  clearCellProgress,
  clearCellRetry,
  queueCell,
} from "./cell-lifecycle.js";

type GridRuntime = {
  grid: Grid;
  references: ReturnType<Store["references"]["loader"]>;
  retries: Map<string, number>;
  owner: string;
  key?: string;
  emittedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type RunningCall = {
  grid: Grid;
  cell: Cell;
  controller: AbortController;
  owner: string;
};

export class Jobs {
  readonly previews: WebsitePreviews;
  readonly persistence = new Persistence(() => this.schedule());
  private grids = new Map<string, GridRuntime>();
  // Calls retain their dispatch owner and worker slot until settlement, even
  // when Pause/Resume replaces the grid's credentials and execution owner.
  private running = new Map<string, RunningCall>();
  private owners = new Map<string, { limit: number; last: number }>();
  private allocation = 0;
  private scheduled = false;
  // Cooldowns outlive idle owner allocation state so Resume cannot bypass them.
  private cooldowns = new Map<string, number>();
  private wake?: ReturnType<typeof setTimeout>;
  constructor(
    private store: Store,
    private provider: Provider,
    readonly workersMax = 100,
    private notify: (grid: Grid) => void = () => {},
  ) {
    if (!Number.isSafeInteger(workersMax) || workersMax < 1)
      throw new Error("WORKERS_MAX must be a positive safe integer");
    this.previews = new WebsitePreviews(
      join(store.files.root, ".previews"),
      (write) => this.persistence.submit(write),
    );
    this.store.billing.persistence = this.persistence;
  }
  private emit(grid: Grid, cells: readonly Cell[]) {
    const state = this.grids.get(grid.id);
    clearTimeout(state?.timer);
    if (state) delete state.timer;
    this.persistence.submit(
      () => this.store.saveGeneration(grid, cells),
      () => {
        this.release(grid);
        this.notify(grid);
      },
    );
  }
  draining = false;
  isRunning(id: string) {
    return this.grids.get(id)?.grid.status === "running";
  }
  private hasUnsettledCalls(id: string) {
    return [...this.running.values()].some(({ grid }) => grid.id === id);
  }
  status() {
    return {
      draining: this.draining,
      persistence: this.persistence.status(),
      runningCalls: this.running.size,
      activeGrids: [...this.grids.values()].filter(
        ({ grid }) => grid.status === "running",
      ).length,
    };
  }
  snapshot(id: string) {
    const stored = this.store.get(id);
    if (!stored) return;
    const state = this.grids.get(id);
    return {
      ...stored,
      ...(state && {
        status: state.grid.status,
        interruption: state.grid.interruption,
        cells: state.grid.cells.map((cell) => ({ ...cell })),
      }),
      live: !!state,
    };
  }
  start(
    grid: Grid,
    key?: string,
    session?: Session,
    commit: (write: () => void) => void = (write) => write(),
  ): Grid {
    if (this.persistence.blocked)
      throw generationFailure(
        "PERSISTENCE_UNAVAILABLE",
        "Generation storage is temporarily unavailable.",
      );
    const current = this.grids.get(grid.id);
    if (current?.grid.status === "running") return current.grid;
    const g = current?.grid ?? grid;
    const owner = session
      ? (session.anonymousId ?? session.id)
      : (current?.owner ?? g.owner);
    const limit =
      this.store.sessionForOwner(owner)?.inferenceConcurrency ??
      this.workersMax;
    const queued = g.cells.filter(
      (cell) => cell.status !== "complete" && cell.status !== "running",
    );
    const prepared = queued.map((cell) => {
      const next = { ...cell };
      queueCell(next);
      return next;
    });
    const next = { ...g, status: "running" as const, interruption: undefined };
    try {
      commit(() => this.store.saveGeneration(next, prepared));
    } catch (error) {
      this.persistence.failed(error, () => {
        this.store.db.prepare("SELECT 1").get();
      });
      throw generationFailure(
        "PERSISTENCE_UNAVAILABLE",
        "Generation storage is temporarily unavailable.",
      );
    }
    clearTimeout(current?.timer);
    const retries = current?.retries ?? new Map<string, number>();
    this.grids.set(g.id, {
      grid: g,
      owner,
      key: key || undefined,
      references: this.store.references.loader(),
      retries,
    });
    this.owners.set(owner, {
      limit,
      last: this.owners.get(owner)?.last ?? 0,
    });
    for (const cell of queued) {
      queueCell(cell);
      retries.delete(cell.id);
    }
    g.status = "running";
    delete g.interruption;
    this.notify(g);
    this.schedule();
    return g;
  }
  pause(grid: Grid): Grid {
    const state = this.grids.get(grid.id);
    const g = state?.grid ?? grid;
    if (g.status === "complete") return g;
    g.status = "paused";
    if (state) delete state.key;
    g.interruption = "manual";
    const changed = new Set<Cell>();
    for (const cell of g.cells) {
      this.previews.clear(cell);
      state?.retries.delete(cell.id);
      if (cell.retrying) changed.add(cell);
      clearCellRetry(cell);
    }
    for (const { grid: runningGrid, cell, controller } of this.running.values())
      if (runningGrid.id === g.id) {
        queueCell(cell);
        changed.add(cell);
        controller.abort();
      }
    this.settle(g);
    this.emit(g, [...changed]);
    this.schedule();
    return g;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      try {
        this.dispatch();
      } catch (error) {
        this.persistence.failed(error, () => {
          this.store.db.prepare("SELECT 1").get();
        });
      }
    });
  }
  private dispatch() {
    if (this.persistence.blocked) return;
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
      for (const { grid, owner } of this.grids.values()) {
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
        this.grids.get(grid.id)?.key ?? this.store.sessionForOwner(owner)?.key;
      const controller = new AbortController();
      const call = { grid, cell, controller, owner };
      const prepared = { ...cell };
      beginCellAttempt(prepared);
      let dispatched = false;
      this.persistence.submit(
        () => {
          if (grid.status !== "running" || cell.status !== "pending") return;
          this.store.saveGeneration(grid, [prepared]);
          dispatched = true;
        },
        () => {
          if (!dispatched) return;
          beginCellAttempt(cell, prepared.attemptId);
          this.running.set(cell.id, call);
          this.owners.get(owner)!.last = ++this.allocation;
          this.notify(grid);
          void this.runCell(call, key);
        },
      );
      if (this.persistence.blocked) return;
    }
  }
  private pauseOwner(owner: string) {
    for (const state of [...this.grids.values()]) {
      const { grid } = state;
      if (state.owner === owner && grid.status === "running") {
        grid.status = "paused";
        state.key = undefined;
        grid.interruption = "billing";
        for (const cell of grid.cells) delete cell.retrying;
        this.settle(grid);
        this.emit(grid, []);
      }
    }
  }
  private settle(grid: Grid) {
    if (this.hasUnsettledCalls(grid.id)) return;
    this.settleState(grid);
  }
  private release(grid: Grid) {
    if (this.hasUnsettledCalls(grid.id)) return;
    if (grid.status !== "running") {
      clearTimeout(this.grids.get(grid.id)?.timer);
      this.grids.delete(grid.id);
    }
    const owners = new Set([...this.grids.values()].map(({ owner }) => owner));
    for (const work of this.running.values()) owners.add(work.owner);
    for (const owner of this.owners.keys())
      if (!owners.has(owner)) this.owners.delete(owner);
  }
  private previewUpdated(grid: Grid) {
    const state = this.grids.get(grid.id)!;
    const delay = Math.max(0, 300 - (Date.now() - (state.emittedAt ?? 0)));
    const flush = () => {
      if (this.grids.get(grid.id) !== state) return;
      state.emittedAt = Date.now();
      delete state.timer;
      this.notify(grid);
    };
    if (!delay) flush();
    else if (!state.timer) state.timer = setTimeout(flush, delay);
  }
  private async runCell(call: RunningCall, key: string | undefined) {
    const { grid, cell, controller, owner } = call;
    const thinkingId = token();
    const current = () =>
      !controller.signal.aborted && this.running.get(cell.id) === call;
    const completed = { ...cell };
    let output: AttemptResult | undefined;
    try {
      if (!key) throw new Error("Reconnect OpenRouter to continue.");
      const references = await this.grids
        .get(grid.id)!
        .references(cell.imageSettings?.input_references ?? []);
      if (!current()) return;
      const result = await generateAttempt(
        this.provider,
        key,
        grid.input.format,
        cell,
        ({ text, thinking, estimatedUsage, currentCallCostUsd }) => {
          if (!current()) return;
          const previousLength = cell.thinking?.length ?? 0;
          if (thinking.length > previousLength) {
            const first = cell.thinkingId !== thinkingId;
            cell.thinkingId = thinkingId;
            this.persistence.submit(() => {
              this.store.files.writeThinking(cell.id, thinkingId, thinking);
              if (first) this.store.saveGeneration(grid, [cell]);
            });
          }
          cell.thinking = thinking;
          const changed = cell.draft !== text;
          cell.draft = text;
          cell.estimatedUsage = estimatedUsage;
          cell.currentCallCostUsd = currentCallCostUsd;
          if (changed && grid.input.format === "html") {
            this.previews.update(cell, text, () => this.previewUpdated(grid));
          }
          this.previewUpdated(grid);
        },
        {
          signal: controller.signal,
          observe: this.store.billing.observe(cell.id, cell.attemptId),
          beforeRequest: () =>
            this.persistence.waitForWrites(controller.signal),
        },
        references,
      );
      if (!current()) return;
      output = result;
      completed.mediaType = result.mediaType;
      completed.usage = result.usage;
      completed.provenance = {
        signature: result.signature,
        maxOutputTokens: result.maxOutputTokens,
        templateSteps: result.templateSteps,
        files: Object.keys(result.files).sort(),
      };
      completed.status = "complete";
      this.grids.get(grid.id)!.retries.delete(cell.id);
    } catch (error) {
      if (!current()) return;
      const failure = failureDetails(error);
      completed.error = failure.message;
      completed.errorCode = failure.code;
      const retries = this.grids.get(grid.id)!.retries;
      const attempt = retries.get(cell.id) ?? 0;
      if (failure.temporary && attempt < 5) {
        completed.status = "pending";
        if (grid.status === "running") {
          completed.retrying = true;
          retries.set(cell.id, attempt + 1);
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
        completed.status = "pending";
        retries.delete(cell.id);
        this.pauseOwner(owner);
      } else {
        completed.status = "error";
        retries.delete(cell.id);
        console.error(
          "Generation failed",
          grid.id,
          cell.id,
          failure.code ?? (error instanceof Error ? error.name : "unknown"),
          JSON.stringify(failureDiagnostics(error)),
        );
      }
    } finally {
      let installed = false;
      let nextCell: Cell;
      let nextGrid: Grid;
      this.persistence.submit(
        () => {
          nextCell = current()
            ? { ...completed, thinkingId: cell.thinkingId }
            : { ...cell };
          if (output && current() && !installed) {
            this.store.files.write(cell.id, output.files);
            installed = true;
          }
          const billing = this.store.billing.cell(cell.id, cell.attemptId);
          if (billing) Object.assign(nextCell, billing);
          clearCellProgress(nextCell);
          if (!output && grid.input.format === "chat-template")
            nextCell.draft = cell.draft;
          nextGrid = {
            ...grid,
            cells: grid.cells.map((c) => (c.id === cell.id ? nextCell : c)),
          };
          const others = [...this.running.values()].some(
            (work) => work.grid.id === grid.id && work !== call,
          );
          if (!others) this.settleState(nextGrid);
          this.store.saveGeneration(nextGrid, [nextCell]);
        },
        () => {
          for (const key of Object.keys(cell))
            delete (cell as unknown as Record<string, unknown>)[key];
          Object.assign(cell, nextCell);
          grid.status = nextGrid.status;
          grid.interruption = nextGrid.interruption;
          this.running.delete(cell.id);
          this.persistence.submit(() => this.previews.clear(cell));
          this.release(grid);
          this.notify(grid);
          this.schedule();
        },
      );
    }
  }
  private settleState(grid: Grid) {
    if (grid.cells.every((cell) => cell.status === "complete")) {
      grid.status = "complete";
      delete grid.interruption;
    } else if (
      grid.status === "running" &&
      !grid.cells.some((cell) => cell.status === "pending")
    )
      grid.status = "paused";
  }
}
