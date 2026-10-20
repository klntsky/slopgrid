import { join } from "node:path";
import type {
  GenerationOutput,
  GenerationTask,
  WorkflowTask,
} from "./domain.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { generateAttempt } from "./generation-attempt.js";
import { loadJudgeMessages, releaseJudgeArtifact } from "./judge-artifact.js";
import { WebsitePreviews } from "./website-previews.js";
import { token } from "./ids.js";
import { referenceIds } from "./image-settings.js";

export type WorkflowExecutionContext = {
  key?: string;
  cellId: string;
  attemptId: string;
  signal: AbortSignal;
  current: () => boolean;
  beforeRequest: () => Promise<void>;
  persist: (write: () => void) => void;
  checkpoint: () => void;
  progress: () => void;
  generation: (id: string) => GenerationTask | undefined;
  retryStorage: <T>(operation: () => Promise<T>) => Promise<T>;
};

export type WorkflowCommit = () => NonNullable<WorkflowTask["output"]>;

export interface WorkflowExecutor {
  run(
    task: WorkflowTask,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowCommit>;
  finish(task: WorkflowTask, successful: boolean): void;
  settled(task: WorkflowTask, tasks: readonly WorkflowTask[]): void;
  clear(tasks: readonly WorkflowTask[]): void;
}

export function createWorkflowExecutor(store: Store, provider: Provider) {
  let persist = (write: () => void) => write();
  const previews = new WebsitePreviews(
    join(store.files.root, ".previews"),
    (write) => persist(write),
  );
  const executor: WorkflowExecutor & { previews: WebsitePreviews } = {
    previews,
    async run(task, context) {
      if (!context.key) throw new Error("Reconnect OpenRouter to continue.");
      persist = context.persist;
      if (task.kind === "judge") {
        const generation = context.generation(task.generationId);
        if (!generation?.output)
          throw new Error("The generated output is unavailable for judging.");
        const messages = await context.retryStorage(() =>
          loadJudgeMessages(store, generation, context.signal),
        );
        context.signal.throwIfAborted();
        if (!context.current()) throw new DOMException("Paused", "AbortError");
        const result = await provider.judge(context.key, task.input, messages, {
          signal: context.signal,
          observe: store.billing.observe(context.cellId, context.attemptId, {
            model: task.input.model,
            effort: task.input.effort,
          }),
          beforeRequest: context.beforeRequest,
        });
        return () => ({ results: result.results });
      }
      const artifactId = token();
      const thinkingId = token();
      const ids = referenceIds(task.input);
      const inputReferences = ids.length
        ? await store.references.loader()(ids)
        : undefined;
      context.signal.throwIfAborted();
      if (!context.current()) throw new DOMException("Paused", "AbortError");
      const result = await generateAttempt(
        provider,
        context.key,
        task.input.format,
        task.input,
        task.id,
        ({ text, thinking, estimatedUsage, currentCallCostUsd }) => {
          if (!context.current()) return;
          const progress = (task.progress ??= {});
          const previousLength = progress.thinking?.length ?? 0;
          if (thinking.length > previousLength) {
            const first = progress.thinkingId !== thinkingId;
            progress.thinkingId = thinkingId;
            progress.thinkingSourceId = artifactId;
            context.persist(() => {
              store.files.writeThinking(artifactId, thinkingId, thinking);
              if (first && context.current()) context.checkpoint();
            });
          }
          progress.thinking = thinking;
          const changed = progress.draft !== text;
          progress.draft = text;
          progress.estimatedUsage = estimatedUsage;
          progress.currentCallCostUsd = currentCallCostUsd;
          if (changed && task.input.format === "html")
            previews.update(task, text, context.progress, context.current);
          context.progress();
        },
        {
          signal: context.signal,
          observe: store.billing.observe(context.cellId, context.attemptId),
          beforeRequest: context.beforeRequest,
        },
        inputReferences,
      );
      let installed = false;
      let output: GenerationOutput | undefined;
      return () => {
        if (output) return output;
        if (!installed) {
          store.files.write(artifactId, result.files);
          installed = true;
        }
        const billing = store.billing.task(task.id, context.attemptId);
        output = {
          artifactId,
          mediaType: result.mediaType,
          usage: billing ? billing.usage : result.usage,
          provenance: {
            signature: result.signature,
            maxOutputTokens: result.maxOutputTokens,
            templateSteps: result.templateSteps,
            files: Object.keys(result.files).sort(),
          },
          thinkingId: task.progress?.thinkingId,
          thinkingSourceId: task.progress?.thinkingSourceId,
        };
        return output;
      };
    },
    finish(task, successful) {
      if (task.kind !== "generation") return;
      const { thinkingId, thinkingSourceId, draft } = task.progress ?? {};
      task.progress = successful
        ? undefined
        : {
            thinkingId,
            thinkingSourceId,
            ...(task.input.format === "chat-template" && { draft }),
          };
      if (!successful) {
        const billing = store.billing.task(task.id, task.attemptId);
        if (billing) (task.progress ??= {}).usage = billing.usage;
      }
    },
    settled(task, tasks) {
      if (task.kind === "generation") previews.clear(task);
      const generation =
        task.kind === "generation"
          ? task
          : tasks.find(
              (candidate): candidate is GenerationTask =>
                candidate.kind === "generation" &&
                candidate.id === task.generationId,
            );
      if (
        generation?.output &&
        tasks.every(
          (candidate) =>
            candidate.kind !== "judge" ||
            candidate.generationId !== generation.id ||
            ((candidate.status === "complete" ||
              candidate.status === "error") &&
              !candidate.retrying),
        )
      )
        releaseJudgeArtifact(store, generation.id);
    },
    clear(tasks) {
      for (const task of tasks) {
        if (task.kind !== "generation") continue;
        previews.clear(task);
        if (task.output) releaseJudgeArtifact(store, task.id);
      }
    },
  };
  return executor;
}
