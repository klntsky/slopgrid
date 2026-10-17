import type { Cell } from "./domain.js";
import { token } from "./ids.js";

export function clearCellProgress(cell: Cell) {
  delete cell.draft;
  delete cell.thinking;
  delete cell.estimatedUsage;
  delete cell.currentCallCostUsd;
}

function clearFailure(cell: Cell) {
  delete cell.error;
  delete cell.errorCode;
}

export function clearCellRetry(cell: Cell) {
  if (!cell.retrying) return;
  delete cell.retrying;
  clearFailure(cell);
}

export function queueCell(cell: Cell) {
  cell.status = "pending";
  clearFailure(cell);
  delete cell.retrying;
  clearCellProgress(cell);
}

export function beginCellAttempt(cell: Cell, attemptId = token()) {
  cell.status = "running";
  cell.attemptId = attemptId;
  // A saved trace remains available while queued, until its replacement starts.
  delete cell.thinkingId;
  delete cell.usage;
  clearFailure(cell);
  delete cell.retrying;
  clearCellProgress(cell);
}
