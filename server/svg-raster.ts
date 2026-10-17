import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { ReferenceContent } from "./image-references.js";
import { svgRasterWorkerURL } from "./svg-raster-worker.mjs";

export async function rasterizeSvg(svg: Uint8Array, signal?: AbortSignal): Promise<ReferenceContent> {
  signal?.throwIfAborted();
  const worker = new Worker(svgRasterWorkerURL, { workerData: svg });
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: Uint8Array | { error: string }) => {
        if (message instanceof Uint8Array) resolve(Buffer.from(message.buffer, message.byteOffset, message.byteLength));
        else reject(new Error(message.error));
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("SVG renderer exited without an image")));
      // Termination in finally also removes the worker's message/error handlers.
      worker.once("exit", () => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error("Could not render this SVG for judging.", { cause: error });
  } finally {
    await worker.terminate();
  }
}
