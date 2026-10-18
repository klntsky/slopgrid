import type { Store } from "./store.js";
import { queueTask } from "./task-lifecycle.js";

/** Recover interrupted work once at application startup, without starting inference. */
export function recoverInterruptedGrids(store: Store) {
  store.billing.recover();
  for (const grid of store.all()) {
    const tasks = store.workflow(grid.id);
    const running = tasks.filter((task) => task.status === "running");
    if (grid.status !== "running" && !running.length) continue;
    grid.status = "paused";
    grid.interruption = "restart";
    for (const task of running) queueTask(task);
    store.saveWorkflow(grid, running);
  }
}
