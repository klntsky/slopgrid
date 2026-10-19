import type { Session, Store } from "./store.js";
import type { GenerationTask, Grid, WorkflowTask } from "./domain.js";
import type { WorkflowCommit, WorkflowExecutor } from "./workflow-executor.js";
import { projectWorkflow } from "./workflow.js";
import { failureDetails, failureDiagnostics } from "./failures.js";
import { selectWorker } from "./worker-allocation.js";
import { Persistence, recoverableStorageError } from "./persistence.js";
import { generationFailure } from "./generation-api.js";
import {
  beginTaskAttempt,
  clearTaskRetry,
  queueTask,
} from "./task-lifecycle.js";

type GridRuntime = {
  grid: Grid;
  tasks: WorkflowTask[];
  retries: Map<string, number>;
  owner: string;
  key?: string;
  emittedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type RunningCall = {
  state: GridRuntime;
  task: WorkflowTask;
  cellId: string;
  controller: AbortController;
  owner: string;
  attemptId: string;
};

export class Jobs {
  readonly persistence = new Persistence(() => this.schedule());
  private grids = new Map<string, GridRuntime>();
  // Dispatch ownership and its worker slot stay pinned until durable settlement,
  // including across Pause/Resume and credential-owner changes.
  private running = new Map<string, RunningCall>();
  private owners = new Map<string, { limit: number; last: number }>();
  private allocation = 0;
  private scheduled = false;
  // Cooldowns outlive idle owner allocation state so Resume cannot bypass them.
  private cooldowns = new Map<string, number>();
  private wake?: ReturnType<typeof setTimeout>;
  draining = false;

  constructor(
    private store: Store,
    private executor: WorkflowExecutor,
    readonly workersMax = 100,
    private notify: (grid: Grid) => void = () => {},
  ) {
    if (!Number.isSafeInteger(workersMax) || workersMax < 1)
      throw new Error("WORKERS_MAX must be a positive safe integer");
    this.store.billing.persistence = this.persistence;
  }

  private emit(state: GridRuntime, tasks: readonly WorkflowTask[]) {
    clearTimeout(state.timer);
    delete state.timer;
    this.persistence.submit(
      () => this.store.saveWorkflow(state.grid, tasks),
      () => {
        projectWorkflow(state.grid, state.tasks);
        this.release(state.grid);
        this.notify(state.grid);
      },
    );
  }

  isRunning(id: string) {
    return this.grids.get(id)?.grid.status === "running";
  }

  private hasUnsettledCalls(id: string) {
    return [...this.running.values()].some(({ state }) => state.grid.id === id);
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
    if (state) projectWorkflow(state.grid, state.tasks);
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
    const tasks = current?.tasks ?? this.store.workflow(g.id);
    const owner = session
      ? (session.anonymousId ?? session.id)
      : (current?.owner ?? g.owner);
    const limit =
      this.store.sessionForOwner(owner)?.inferenceConcurrency ??
      this.workersMax;
    const queued = tasks.filter(
      (task) => task.status !== "running" && task.status !== "complete",
    );
    const prepared = queued.map((task) => {
      const next = { ...task };
      queueTask(next);
      return next;
    });
    const next = { ...g, status: "running" as const, interruption: undefined };
    try {
      commit(() => this.store.saveWorkflow(next, prepared));
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
      tasks,
      owner,
      key: key || undefined,
      retries,
    });
    this.owners.set(owner, {
      limit,
      last: this.owners.get(owner)?.last ?? 0,
    });
    for (const task of queued) {
      queueTask(task);
      retries.delete(task.id);
    }
    g.status = "running";
    delete g.interruption;
    projectWorkflow(g, tasks);
    this.notify(g);
    this.schedule();
    return g;
  }

  pause(grid: Grid): Grid {
    const state = this.grids.get(grid.id) ?? {
      grid,
      tasks: this.store.workflow(grid.id),
      retries: new Map<string, number>(),
      owner: grid.owner,
    };
    const g = state.grid;
    if (g.status === "complete") return g;
    g.status = "paused";
    delete state.key;
    g.interruption = "manual";
    const changed = new Set<WorkflowTask>();
    for (const task of state.tasks) {
      state.retries.delete(task.id);
      if (task.retrying) changed.add(task);
      clearTaskRetry(task);
    }
    this.executor.clear(state.tasks);
    for (const {
      state: runningState,
      task,
      controller,
    } of this.running.values())
      if (runningState.grid.id === g.id) {
        queueTask(task);
        changed.add(task);
        controller.abort();
      }
    if (!this.hasUnsettledCalls(g.id)) this.settleState(g, state.tasks);
    projectWorkflow(g, state.tasks);
    this.emit(state, [...changed]);
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

  private ready(state: GridRuntime, task: WorkflowTask) {
    return (
      task.status === "pending" &&
      !this.running.has(task.id) &&
      (task.kind !== "judge" ||
        state.tasks.some(
          (dependency) =>
            dependency.id === task.generationId &&
            dependency.status === "complete",
        ))
    );
  }

  private dispatch() {
    if (this.persistence.blocked) return;
    clearTimeout(this.wake);
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
      const candidates = new Map<
        string,
        { state: GridRuntime; task: WorkflowTask }
      >();
      for (const state of this.grids.values()) {
        const { grid, owner } = state;
        if (
          grid.status !== "running" ||
          (this.cooldowns.get(owner) ?? 0) > now ||
          candidates.has(owner) ||
          [...this.running.values()].filter(
            (work) => work.state.grid.id === grid.id,
          ).length >= (grid.input.parallelWorkers ?? this.workersMax)
        )
          continue;
        const task = state.tasks.find((task) => this.ready(state, task));
        if (task) candidates.set(owner, { state, task });
      }
      const owner = selectWorker(
        this.owners,
        candidates.keys(),
        [...this.running.values()].map((work) => work.owner),
        this.workersMax,
      );
      if (owner === undefined) return;
      const { state, task } = candidates.get(owner)!;
      const { grid } = state;
      const key = state.key ?? this.store.sessionForOwner(owner)?.key;
      const prepared = { ...task };
      beginTaskAttempt(prepared);
      const cell = grid.cells.find((cell) =>
        task.kind === "judge"
          ? cell.judgmentId === task.id
          : cell.generationId === task.id,
      );
      if (!cell)
        throw new Error("Workflow task has no billing attribution cell");
      const call: RunningCall = {
        state,
        task,
        cellId: cell.id,
        controller: new AbortController(),
        owner,
        attemptId: prepared.attemptId!,
      };
      let dispatched = false;
      this.persistence.submit(
        () => {
          if (
            this.grids.get(grid.id) !== state ||
            grid.status !== "running" ||
            !this.ready(state, task)
          )
            return;
          this.store.saveWorkflow(grid, [prepared]);
          dispatched = true;
        },
        () => {
          if (!dispatched) return;
          beginTaskAttempt(task, call.attemptId);
          this.running.set(task.id, call);
          this.owners.get(owner)!.last = ++this.allocation;
          projectWorkflow(grid, state.tasks);
          this.notify(grid);
          void this.run(call, key);
        },
      );
      if (this.persistence.blocked) return;
    }
  }

  private async retryStorage<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ) {
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

  private current(call: RunningCall) {
    return (
      !call.controller.signal.aborted &&
      this.running.get(call.task.id) === call &&
      call.task.attemptId === call.attemptId
    );
  }

  private pauseOwner(owner: string) {
    for (const state of [...this.grids.values()]) {
      const { grid } = state;
      if (state.owner !== owner || grid.status !== "running") continue;
      grid.status = "paused";
      delete state.key;
      grid.interruption = "billing";
      for (const task of state.tasks) clearTaskRetry(task);
      this.executor.clear(state.tasks);
      if (!this.hasUnsettledCalls(grid.id)) this.settleState(grid, state.tasks);
      this.emit(state, []);
    }
  }

  private release(grid: Grid) {
    if (this.hasUnsettledCalls(grid.id)) return;
    const state = this.grids.get(grid.id);
    if (state && grid.status !== "running") {
      clearTimeout(state.timer);
      this.executor.clear(state.tasks);
      this.grids.delete(grid.id);
    }
    const owners = new Set([...this.grids.values()].map(({ owner }) => owner));
    for (const work of this.running.values()) owners.add(work.owner);
    for (const owner of this.owners.keys())
      if (!owners.has(owner)) this.owners.delete(owner);
  }

  private progressUpdated(state: GridRuntime) {
    if (this.grids.get(state.grid.id)?.tasks !== state.tasks) return;
    const live = this.grids.get(state.grid.id)!;
    const delay = Math.max(0, 300 - (Date.now() - (live.emittedAt ?? 0)));
    const flush = () => {
      if (this.grids.get(live.grid.id) !== live) return;
      live.emittedAt = Date.now();
      delete live.timer;
      projectWorkflow(live.grid, live.tasks);
      this.notify(live.grid);
    };
    if (!delay) flush();
    else if (!live.timer) live.timer = setTimeout(flush, delay);
  }

  private failAttempt(
    call: RunningCall,
    completed: WorkflowTask,
    error: unknown,
  ) {
    const { state, task, owner } = call;
    const failure = failureDetails(error);
    completed.error = failure.message;
    completed.errorCode = failure.code;
    const retries = this.grids.get(state.grid.id)!.retries;
    const attempt = retries.get(task.id) ?? 0;
    if (failure.temporary && attempt < 5) {
      completed.status = "pending";
      if (state.grid.status === "running") {
        completed.retrying = true;
        retries.set(task.id, attempt + 1);
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
      retries.delete(task.id);
      this.pauseOwner(owner);
    } else {
      completed.status = "error";
      retries.delete(task.id);
      console.error(
        "Workflow task failed",
        state.grid.id,
        task.id,
        failure.code ?? (error instanceof Error ? error.name : "unknown"),
        JSON.stringify(failureDiagnostics(error)),
      );
    }
  }

  private async run(call: RunningCall, key: string | undefined) {
    const { state, task, controller } = call;
    const { grid, tasks } = state;
    let commit: WorkflowCommit | undefined;
    let completed: WorkflowTask | undefined;
    try {
      commit = await this.executor.run(task, {
        key,
        cellId: call.cellId,
        attemptId: call.attemptId,
        signal: controller.signal,
        current: () => this.current(call),
        beforeRequest: () => this.persistence.waitForWrites(controller.signal),
        persist: (write) => this.persistence.submit(write),
        checkpoint: () => this.store.saveWorkflow(grid, [task]),
        progress: () => this.progressUpdated(state),
        generation: (id) =>
          tasks.find(
            (candidate): candidate is GenerationTask =>
              candidate.kind === "generation" && candidate.id === id,
          ),
        retryStorage: (operation) =>
          this.retryStorage(operation, controller.signal),
      });
      if (this.current(call)) this.grids.get(grid.id)!.retries.delete(task.id);
    } catch (error) {
      if (this.current(call)) {
        completed = { ...task };
        this.failAttempt(call, completed, error);
      }
    } finally {
      let nextTask: WorkflowTask;
      let nextGrid: Grid;
      // Provider and billing work runs once. Storage retries only repeat this
      // synchronous commit, rechecking attempt identity before publishing output.
      this.persistence.submit(
        () => {
          const current = this.current(call);
          nextTask = { ...(current && completed ? completed : task) };
          if (current && commit)
            Object.assign(nextTask, { output: commit(), status: "complete" });
          this.executor.finish(nextTask, current && !!commit);
          nextGrid = { ...grid };
          const nextTasks = tasks.map((candidate) =>
            candidate.id === task.id ? nextTask : candidate,
          );
          const others = [...this.running.values()].some(
            (work) => work.state.grid.id === grid.id && work !== call,
          );
          if (!others) this.settleState(nextGrid, nextTasks);
          this.store.saveWorkflow(nextGrid, [nextTask]);
        },
        () => {
          for (const key of Object.keys(task))
            delete (task as unknown as Record<string, unknown>)[key];
          Object.assign(task, nextTask);
          grid.status = nextGrid.status;
          grid.interruption = nextGrid.interruption;
          this.running.delete(task.id);
          this.executor.settled(task, tasks);
          projectWorkflow(grid, tasks);
          this.release(grid);
          this.notify(grid);
          this.schedule();
        },
      );
    }
  }

  private settleState(grid: Grid, tasks: readonly WorkflowTask[]) {
    if (tasks.every((task) => task.status === "complete")) {
      grid.status = "complete";
      delete grid.interruption;
    } else if (
      grid.status === "running" &&
      !tasks.some(
        (task) =>
          task.status === "pending" &&
          (task.kind !== "judge" ||
            tasks.some(
              (dependency) =>
                dependency.id === task.generationId &&
                dependency.status === "complete",
            )),
      )
    )
      grid.status = "paused";
  }
}
