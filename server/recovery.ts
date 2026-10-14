import type { Store } from "./store.js";

/** Recover interrupted work once at application startup, without starting inference. */
export function recoverInterruptedGrids(store: Store) {
  store.billing.recover();
  for (const grid of store.all()) {
    const running = grid.cells.filter((cell) => cell.status === "running");
    const interrupted = grid.status === "running" || running.length > 0;
    if (!interrupted && !grid.hasUnsettledCalls) continue;
    if (interrupted) {
      grid.status = "paused";
      grid.interruption = "restart";
      for (const cell of running) cell.status = "pending";
    }
    // Clearing the durable marker and advancing the revision share one commit,
    // even when Pause already made every cell pending and billing has finished.
    grid.hasUnsettledCalls = false;
    store.saveGeneration(grid, running);
  }
}
