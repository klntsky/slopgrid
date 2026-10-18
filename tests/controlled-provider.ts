import { Provider } from "../server/provider.js";
import type {
  Grid,
  Cell,
  GenerationParameters,
  InferenceProgress,
} from "../server/domain.js";
import type { CallObserver } from "../server/billing.js";
import type { ReferenceContent } from "../server/image-references.js";

type Result = Awaited<ReturnType<Provider["generate"]>>;
export class ControlledProvider extends Provider {
  started: { id: string; owner: string }[] = [];
  pending = new Map<
    string,
    {
      resolve: (r: Result) => void;
      reject: (e: unknown) => void;
      write: (
        text: string,
        estimatedUsage?: Cell["usage"],
        thinking?: string,
      ) => void;
    }
  >();
  override generate(
    _key: string,
    _format: Grid["input"]["format"],
    input: GenerationParameters,
    onChunk: (progress: InferenceProgress) => void,
    signal?: AbortSignal,
    _observe?: CallObserver,
    _references?: ReferenceContent[],
    _beforeRequest?: () => Promise<void>,
    taskId?: string,
  ): Promise<Result> {
    if (!taskId) throw new Error("Controlled generation requires a task ID.");
    this.started.push({ id: taskId, owner: input.prompt.split(" ")[0] });
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(taskId);
        reject(new DOMException("Paused", "AbortError"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(taskId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        write: (text, estimatedUsage, thinking = "") =>
          onChunk({ text, thinking, estimatedUsage }),
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  finish(id: string) {
    const held = this.pending.get(id)!;
    this.pending.delete(id);
    held.resolve({ signature: "fixture-signature", files: { "index.md": id } });
  }
  fail(id: string, statusCode: number, extra: Record<string, unknown> = {}) {
    const held = this.pending.get(id)!;
    this.pending.delete(id);
    held.reject({ statusCode, ...extra });
  }
  owners() {
    const owners = new Map(this.started.map(({ id, owner }) => [id, owner]));
    return [...this.pending.keys()].map((id) => owners.get(id)!);
  }
}
