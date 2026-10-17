import type { Store } from "./store.js";
import { clearCellProgress } from "./cell-lifecycle.js";

/** Recover interrupted work once at application startup, without starting inference. */
export function recoverInterruptedGrids(store: Store) {
  store.billing.recover();
  for (const grid of store.all()) {
    const running = grid.cells.filter((cell) => cell.status === "running");
    if (grid.status !== "running" && !running.length) continue;
    grid.status = "paused";
    grid.interruption = "restart";
    for (const cell of running) {
      cell.status = "pending";
      clearCellProgress(cell);
    }
    store.saveGeneration(grid, running);
  }
}
