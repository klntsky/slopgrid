import type { Store } from "./store.js";

/** Recover interrupted work once at application startup, without starting inference. */
export function recoverInterruptedGrids(store: Store) {
  store.billing.recover();
  for (const grid of store.all()) {
    if (
      grid.status !== "running" &&
      !grid.cells.some((cell) => cell.status === "running")
    )
      continue;
    grid.status = "paused";
    grid.interruption = "restart";
    for (const cell of grid.cells)
      if (cell.status === "running") cell.status = "pending";
    store.saveGeneration(grid);
  }
}
