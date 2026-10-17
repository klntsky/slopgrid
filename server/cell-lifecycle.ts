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
  if (cell.retrying) {
    delete cell.retrying;
    clearFailure(cell);
  }
  if (cell.judge?.retrying) {
    cell.judge = { ...cell.judge };
    delete cell.judge.retrying;
    delete cell.judge.error;
    delete cell.judge.errorCode;
  }
}

export function queueCell(cell: Cell) {
  cell.status = "pending";
  clearFailure(cell);
  delete cell.retrying;
  if (cell.judge) {
    cell.judge = { ...cell.judge };
    if (cell.judge.status !== "complete") {
      cell.judge.status = "pending";
      delete cell.judge.error;
      delete cell.judge.errorCode;
      delete cell.judge.retrying;
    }
    if (cell.generationSourceId === cell.id) {
      if (cell.provenance?.files.length) cell.generationStatus = "complete";
      else if (cell.generationStatus !== "complete")
        cell.generationStatus = "pending";
    }
    // Judging never replaces the generation trace, usage, or committed output.
    if (cell.provenance?.files.length) return;
  }
  clearCellProgress(cell);
}

export function beginCellAttempt(cell: Cell, attemptId = token()) {
  cell.status = "running";
  cell.attemptId = attemptId;
  if (cell.generationSourceId === cell.id) cell.generationStatus = "running";
  // A saved trace remains available while queued, until its replacement starts.
  delete cell.thinkingId;
  delete cell.usage;
  clearFailure(cell);
  delete cell.retrying;
  clearCellProgress(cell);
}

export function beginJudgeAttempt(cell: Cell, attemptId = token()) {
  if (!cell.judge) throw new Error("This cell has no judge");
  cell.status = "running";
  cell.judge = {
    model: cell.judge.model,
    effort: cell.judge.effort,
    status: "running",
    attemptId,
  };
}
