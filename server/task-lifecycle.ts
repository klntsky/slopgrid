import type { WorkflowTask } from "./domain.js";
import { token } from "./ids.js";

function clearFailure(task: WorkflowTask) {
  delete task.error;
  delete task.errorCode;
}

export function clearTaskRetry(task: WorkflowTask) {
  if (!task.retrying) return;
  delete task.retrying;
  clearFailure(task);
}

export function queueTask(task: WorkflowTask) {
  task.status = "pending";
  clearFailure(task);
  delete task.retrying;
  if (task.kind === "generation" && task.progress) {
    const { thinkingId, thinkingSourceId, draft } = task.progress;
    task.progress = {
      thinkingId,
      thinkingSourceId,
      ...(task.input.format === "chat-template" && { draft }),
    };
  }
}

export function beginTaskAttempt(task: WorkflowTask, attemptId = token()) {
  task.status = "running";
  task.attemptId = attemptId;
  clearFailure(task);
  delete task.retrying;
  delete task.output;
  if (task.kind === "generation") delete task.progress;
}
