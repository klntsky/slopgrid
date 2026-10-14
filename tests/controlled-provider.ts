import { Provider } from "../server/provider.js";
import type { Grid, Cell, InferenceProgress } from "../server/domain.js";

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
    cell: Cell,
    onChunk: (progress: InferenceProgress) => void,
    signal?: AbortSignal,
  ): Promise<Result> {
    this.started.push({ id: cell.id, owner: cell.prompt.split(" ")[0] });
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(cell.id);
        reject(new DOMException("Paused", "AbortError"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(cell.id, {
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
    return [...this.pending.keys()].map((id) => id.split("/")[0]);
  }
}
