import type { Session } from "./store.js";
import { token } from "./ids.js";
import { join } from "node:path";
import { WebsitePreviews } from "./website-previews.js";
import type { Cell, Grid, GridInput } from "./domain.js";
import type { Store } from "./store.js";
import { Provider } from "./provider.js";
import { failureDetails, failureDiagnostics } from "./failures.js";
import { selectWorker } from "./worker-allocation.js";
import { Persistence, recoverableStorageError } from "./persistence.js";
import { generationFailure } from "./generation-api.js";
import { generateAttempt, type AttemptResult } from "./generation-attempt.js";
import { prepareJudgeInference } from "./judge.js";
import { loadJudgeArtifact, releaseJudgeArtifact } from "./judge-artifact.js";
import {
  beginCellAttempt,
  beginJudgeAttempt,
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
  readyOutputs: Set<string>;
};

type RunningCall = {
  grid: Grid;
  cell: Cell;
  controller: AbortController;
  owner: string;
  stage: "generation" | "judge";
  attemptId: string;
};

type CopyingGroup = {
  state: GridRuntime;
  source: Cell;
  controller: AbortController;
};

export class Jobs {
  readonly previews: WebsitePreviews;
  readonly persistence = new Persistence(() => this.schedule());
  private grids = new Map<string, GridRuntime>();
  // Calls retain their dispatch owner and worker slot until settlement, even
  // when Pause/Resume replaces the grid's credentials and execution owner.
  private running = new Map<string, RunningCall>();
  // Artifact fan-out is storage work, not an inference worker reservation.
  private copying = new Map<string, CopyingGroup>();
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
    return (
      [...this.running.values()].some(({ grid }) => grid.id === id) ||
      [...this.copying.values()].some(({ state }) => state.grid.id === id)
    );
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
      (cell) =>
        cell.status !== "running" &&
        (cell.status !== "complete" ||
          (cell.judge && cell.judge.status !== "complete")),
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
      readyOutputs: current?.readyOutputs ?? new Set(),
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
      if (cell.retrying || cell.judge?.retrying) changed.add(cell);
      clearCellRetry(cell);
    }
    for (const work of this.copying.values())
      if (work.state.grid.id === g.id) work.controller.abort();
    this.releaseJudgeArtifacts(g);
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
  private nextStage(
    state: GridRuntime,
    cell: Cell,
  ): RunningCall["stage"] | undefined {
    if (cell.status !== "pending" || this.running.has(cell.id)) return;
    if (!cell.judge) return "generation";
    if (
      cell.generationSourceId === cell.id &&
      cell.generationStatus !== "complete" &&
      !cell.provenance?.files.length
    )
      return "generation";
    if (state.readyOutputs.has(cell.id) && cell.judge.status === "pending")
      return "judge";
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
    this.prepareGroups();
    for (;;) {
      const candidates = new Map<
        string,
        { state: GridRuntime; cell: Cell; stage: RunningCall["stage"] }
      >();
      for (const state of this.grids.values()) {
        const { grid, owner } = state;
        if (
          grid.status !== "running" ||
          (this.cooldowns.get(owner) ?? 0) > now ||
          candidates.has(owner) ||
          [...this.running.values()].filter((work) => work.grid.id === grid.id)
            .length >= (grid.input.parallelWorkers ?? this.workersMax)
        )
          continue;
        const cell = grid.cells.find((cell) => this.nextStage(state, cell));
        if (cell)
          candidates.set(owner, {
            state,
            cell,
            stage: this.nextStage(state, cell)!,
          });
      }
      const owner = selectWorker(
        this.owners,
        candidates.keys(),
        [...this.running.values()].map((work) => work.owner),
        this.workersMax,
      );
      if (owner === undefined) return;
      const { state, cell, stage } = candidates.get(owner)!;
      const { grid } = state;
      const key = state.key ?? this.store.sessionForOwner(owner)?.key;
      const controller = new AbortController();
      const prepared = { ...cell };
      if (stage === "generation") beginCellAttempt(prepared);
      else beginJudgeAttempt(prepared);
      const call: RunningCall = {
        grid,
        cell,
        controller,
        owner,
        stage,
        attemptId:
          stage === "generation"
            ? prepared.attemptId!
            : prepared.judge!.attemptId!,
      };
      const dependents =
        stage === "generation" && cell.judge
          ? grid.cells
              .filter(
                (member) =>
                  member.id !== cell.id &&
                  member.generationSourceId === cell.id,
              )
              .map((member) => {
                const next = { ...member };
                queueCell(next);
                return next;
              })
          : [];
      let dispatched = false;
      this.persistence.submit(
        () => {
          if (
            this.grids.get(grid.id) !== state ||
            grid.status !== "running" ||
            this.nextStage(state, cell) !== stage
          )
            return;
          this.store.saveGeneration(grid, [prepared, ...dependents]);
          dispatched = true;
        },
        () => {
          if (!dispatched) return;
          if (stage === "generation") beginCellAttempt(cell, call.attemptId);
          else beginJudgeAttempt(cell, call.attemptId);
          for (const next of dependents)
            this.installCell(
              grid.cells.find((member) => member.id === next.id)!,
              next,
            );
          this.running.set(cell.id, call);
          this.owners.get(owner)!.last = ++this.allocation;
          this.notify(grid);
          if (stage === "generation") void this.runCell(call, key);
          else void this.runJudge(call, key);
        },
      );
      if (this.persistence.blocked) return;
    }
  }
  private prepareGroups() {
    for (const state of this.grids.values()) {
      if (state.grid.status !== "running") continue;
      for (const source of state.grid.cells) {
        if (
          source.generationSourceId !== source.id ||
          (source.generationStatus !== "complete" &&
            !source.provenance?.files.length) ||
          this.copying.has(source.id) ||
          !state.grid.cells.some(
            (cell) =>
              cell.generationSourceId === source.id &&
              cell.status === "pending" &&
              !state.readyOutputs.has(cell.id),
          )
        )
          continue;
        const work = { state, source, controller: new AbortController() };
        this.copying.set(source.id, work);
        void this.copyGroup(work);
      }
    }
  }
  private async retryStorage<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    for (;;) {
      await this.persistence.waitForWrites(signal);
      try {
        return await operation();
      } catch (error) {
        signal.throwIfAborted();
        if (!recoverableStorageError(error)) throw error;
        this.persistence.failed(error, () => {
          this.store.db.prepare("SELECT 1").get();
        });
      }
    }
  }
  private async copyGroup(work: CopyingGroup) {
    const { state, source, controller } = work;
    const { grid } = state;
    const current = () =>
      !controller.signal.aborted &&
      this.copying.get(source.id) === work &&
      this.grids.get(grid.id) === state &&
      grid.status === "running";
    const members = grid.cells.filter(
      (cell) =>
        cell.generationSourceId === source.id &&
        cell.status === "pending" &&
        !state.readyOutputs.has(cell.id),
    );
    let patches: Cell[] = [];
    let ready = false;
    try {
      patches = await this.retryStorage(async () => {
        controller.signal.throwIfAborted();
        const provenance = source.provenance;
        const bundle = provenance?.files.length
          ? await this.store.files.readArtifact(
              source.id,
              provenance.files,
              source.thinkingId,
            )
          : undefined;
        if (!bundle || !provenance)
          throw new Error("The generated output is unavailable for judging.");
        const copied: Cell[] = [];
        for (const member of members) {
          controller.signal.throwIfAborted();
          if (!current()) return [];
          if (member.id === source.id) continue;
          const matching =
            member.provenance?.signature === provenance.signature &&
            member.provenance.files.length === provenance.files.length &&
            member.provenance.files.every(
              (file, index) => file === provenance.files[index],
            );
          const existing = matching
            ? await this.store.files.readArtifact(
                member.id,
                provenance.files,
                member.thinkingId,
              )
            : undefined;
          let thinkingId = member.thinkingId;
          if (!existing) {
            // writeArtifact deliberately does not replace an existing directory.
            // A crash may leave files without their corresponding SQLite commit.
            await this.store.files.removeArtifact(member.id);
            controller.signal.throwIfAborted();
            thinkingId = await this.store.files.writeArtifact(
              member.id,
              bundle,
            );
          }
          const next = {
            ...member,
            provenance,
            usage: source.usage,
            mediaType: source.mediaType,
            thinkingId,
          };
          delete next.attemptId;
          delete next.generationStatus;
          copied.push(next);
        }
        return copied;
      }, controller.signal);
      ready = true;
    } catch (error) {
      if (current()) {
        const failure = failureDetails(error);
        patches = members.map((member) => ({
          ...member,
          status: "error",
          judge: {
            ...member.judge!,
            status: "error",
            error: failure.message,
            errorCode: failure.code,
          },
        }));
      }
    }
    try {
      if (!current()) return;
      // File I/O has finished. The persistence queue contains synchronous writes
      // only, and retries never replay a copy or an upstream inference request.
      await new Promise<void>((resolve) => {
        let committed = false;
        this.persistence.submit(
          () => {
            if (!current()) return;
            this.store.saveGeneration(grid, patches);
            committed = true;
          },
          () => {
            if (committed) {
              for (const patch of patches)
                this.installCell(
                  grid.cells.find((cell) => cell.id === patch.id)!,
                  patch,
                );
              if (ready)
                for (const member of members) state.readyOutputs.add(member.id);
            }
            resolve();
          },
        );
      });
    } finally {
      if (this.copying.get(source.id) === work) this.copying.delete(source.id);
      this.settle(grid);
      this.emit(grid, []);
      this.schedule();
    }
  }
  private installCell(cell: Cell, next: Cell) {
    for (const key of Object.keys(cell))
      delete (cell as unknown as Record<string, unknown>)[key];
    Object.assign(cell, next);
  }
  private current(call: RunningCall) {
    return (
      !call.controller.signal.aborted &&
      this.running.get(call.cell.id) === call &&
      (call.stage === "generation"
        ? call.cell.attemptId
        : call.cell.judge?.attemptId) === call.attemptId
    );
  }
  private releaseJudgeArtifacts(grid: Grid) {
    for (const cell of grid.cells)
      if (cell.generationSourceId === cell.id)
        releaseJudgeArtifact(this.store, cell.id);
  }
  private releaseSettledJudgeArtifact(grid: Grid, cell: Cell) {
    const sourceId = cell.generationSourceId;
    if (
      sourceId &&
      grid.cells
        .filter((member) => member.generationSourceId === sourceId)
        .every(
          (member) =>
            (member.judge?.status === "complete" ||
              member.judge?.status === "error") &&
            !member.judge.retrying,
        )
    )
      releaseJudgeArtifact(this.store, sourceId);
  }
  private pauseOwner(owner: string) {
    for (const state of [...this.grids.values()]) {
      const { grid } = state;
      if (state.owner === owner && grid.status === "running") {
        grid.status = "paused";
        state.key = undefined;
        grid.interruption = "billing";
        for (const cell of grid.cells) clearCellRetry(cell);
        for (const work of this.copying.values())
          if (work.state.grid.id === grid.id) work.controller.abort();
        this.releaseJudgeArtifacts(grid);
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
      this.releaseJudgeArtifacts(grid);
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
  private failAttempt(call: RunningCall, completed: Cell, error: unknown) {
    const { grid, cell, owner } = call;
    const target = call.stage === "judge" ? completed.judge! : completed;
    const failure = failureDetails(error);
    target.error = failure.message;
    target.errorCode = failure.code;
    const retries = this.grids.get(grid.id)!.retries;
    const attempt = retries.get(cell.id) ?? 0;
    if (failure.temporary && attempt < 5) {
      target.status = "pending";
      if (grid.status === "running") {
        target.retrying = true;
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
      target.status = "pending";
      retries.delete(cell.id);
      this.pauseOwner(owner);
    } else {
      target.status = "error";
      retries.delete(cell.id);
      console.error(
        call.stage === "judge" ? "Judging failed" : "Generation failed",
        grid.id,
        cell.id,
        failure.code ?? (error instanceof Error ? error.name : "unknown"),
        JSON.stringify(failureDiagnostics(error)),
      );
    }
    completed.status = target.status;
    if (call.stage === "generation" && cell.judge)
      completed.generationStatus = completed.status;
  }
  private async runJudge(call: RunningCall, key: string | undefined) {
    const { grid, cell, controller } = call;
    const completed = { ...cell, judge: { ...cell.judge! } };
    try {
      if (!key) throw new Error("Reconnect OpenRouter to continue.");
      const artifact = await this.retryStorage(
        () =>
          loadJudgeArtifact(
            this.store,
            grid.input.format,
            cell,
            controller.signal,
          ),
        controller.signal,
      );
      if (!this.current(call)) return;
      const result = await this.provider.judge(
        key,
        prepareJudgeInference({
          format: grid.input.format,
          model: cell.judge!.model,
          effort: cell.judge!.effort as GridInput["effort"],
          criteria: grid.input.judge!.criteria.map(
            (criterion) => criterion.text,
          ),
          artifact,
        }),
        {
          signal: controller.signal,
          observe: this.store.billing.observe(cell.id, call.attemptId, {
            model: cell.judge!.model,
            effort: cell.judge!.effort,
          }),
          beforeRequest: () =>
            this.persistence.waitForWrites(controller.signal),
        },
      );
      if (!this.current(call)) return;
      completed.judge.status = "complete";
      completed.judge.results = result.results;
      completed.status = "complete";
      this.grids.get(grid.id)!.retries.delete(cell.id);
    } catch (error) {
      if (!this.current(call)) return;
      this.failAttempt(call, completed, error);
    } finally {
      let nextCell: Cell;
      let nextGrid: Grid;
      // Billing writes are already queued; verdicts commit behind that barrier.
      // Re-evaluate identity on every storage retry, never the provider request.
      this.persistence.submit(
        () => {
          nextCell = this.current(call) ? completed : { ...cell };
          nextGrid = {
            ...grid,
            cells: grid.cells.map((member) =>
              member.id === cell.id ? nextCell : member,
            ),
          };
          const others =
            [...this.running.values()].some(
              (work) => work.grid.id === grid.id && work !== call,
            ) ||
            [...this.copying.values()].some(
              (work) => work.state.grid.id === grid.id,
            );
          if (!others) this.settleState(nextGrid);
          this.store.saveGeneration(nextGrid, [nextCell]);
        },
        () => {
          this.installCell(cell, nextCell);
          grid.status = nextGrid.status;
          grid.interruption = nextGrid.interruption;
          this.running.delete(cell.id);
          this.releaseSettledJudgeArtifact(grid, cell);
          this.release(grid);
          this.notify(grid);
          this.schedule();
        },
      );
    }
  }
  private async runCell(call: RunningCall, key: string | undefined) {
    const { grid, cell, controller } = call;
    const thinkingId = token();
    const current = () => this.current(call);
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
          observe: this.store.billing.observe(cell.id, call.attemptId),
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
      completed.status = cell.judge ? "pending" : "complete";
      if (cell.judge) completed.generationStatus = "complete";
      this.grids.get(grid.id)!.retries.delete(cell.id);
    } catch (error) {
      if (!current()) return;
      this.failAttempt(call, completed, error);
    } finally {
      let installed = false;
      let nextCell: Cell;
      let changed: Cell[];
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
          const billing = this.store.billing.cell(cell.id, call.attemptId);
          if (billing) Object.assign(nextCell, billing);
          clearCellProgress(nextCell);
          if (!output && grid.input.format === "chat-template")
            nextCell.draft = cell.draft;
          changed = [nextCell];
          if (cell.judge && current() && !output) {
            for (const member of grid.cells) {
              if (
                member.id === cell.id ||
                member.generationSourceId !== cell.id
              )
                continue;
              changed.push({
                ...member,
                status: nextCell.status,
                error: nextCell.error,
                errorCode: nextCell.errorCode,
                retrying: nextCell.retrying,
              });
            }
          }
          const updates = new Map(changed.map((member) => [member.id, member]));
          nextGrid = {
            ...grid,
            cells: grid.cells.map((member) => updates.get(member.id) ?? member),
          };
          const others =
            [...this.running.values()].some(
              (work) => work.grid.id === grid.id && work !== call,
            ) ||
            [...this.copying.values()].some(
              (work) => work.state.grid.id === grid.id,
            );
          if (!others) this.settleState(nextGrid);
          this.store.saveGeneration(nextGrid, changed);
        },
        () => {
          for (const next of changed)
            this.installCell(
              grid.cells.find((member) => member.id === next.id)!,
              next,
            );
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
    if (
      grid.cells.every(
        (cell) =>
          cell.status === "complete" &&
          (!cell.judge || cell.judge.status === "complete"),
      )
    ) {
      grid.status = "complete";
      delete grid.interruption;
    } else if (
      grid.status === "running" &&
      !grid.cells.some((cell) => cell.status === "pending")
    )
      grid.status = "paused";
  }
}
