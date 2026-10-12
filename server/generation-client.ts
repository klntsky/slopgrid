import { request, type IncomingMessage, type RequestOptions } from "node:http";
import { createInterface } from "node:readline";
import { json } from "node:stream/consumers";
import {
  generationProtocol,
  generationError,
  generationFailure,
  type GenerationAPI,
} from "./generation-api.js";

export function generationClient(socketPath: string): GenerationAPI {
  const unavailable = () =>
    generationFailure("UNAVAILABLE", "Generation service is unavailable.");
  function open(path: string, options: RequestOptions, body?: unknown) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath, path, ...options }, (res) => {
        if (
          res.headers["x-generation-protocol"] !== String(generationProtocol)
        ) {
          res.destroy();
          reject(unavailable());
        } else resolve(res);
      });
      req.on("error", reject);
      // Subscriptions have no idle timeout; their AbortSignal owns cancellation.
      if (!options.signal)
        req.setTimeout(10000, () => req.destroy(unavailable()));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let failure;
    try {
      const res = await open(
        path,
        { method, headers: { "Content-Type": "application/json" } },
        body,
      );
      const value = await json(res);
      if (res.statusCode === 200) return value as T;
      failure = generationError.parse(value);
    } catch {
      throw unavailable();
    }
    throw generationFailure(failure.code, failure.error);
  }
  return {
    startGrid: (body) => call("POST", "/v1/grids/start", body),
    pauseGrid: (body) => call("POST", "/v1/grids/pause", body),
    getGrid: (id) => call("GET", `/v1/grids/${encodeURIComponent(id)}`),
    previewPath: async (body) =>
      (await call<{ path: string | null }>("POST", "/v1/previews/path", body))
        .path ?? undefined,
    status: () => call("GET", "/v1/status"),
    drain: () => call("POST", "/v1/drain"),
    accept: () => call("POST", "/v1/accept"),
    subscribeGrid(id, snapshot, disconnected) {
      const controller = new AbortController();
      const { signal } = controller;
      void (async () => {
        try {
          const res = await open(`/v1/grids/${encodeURIComponent(id)}/events`, {
            signal,
          });
          if (res.statusCode !== 200) throw unavailable();
          const lines = createInterface({ input: res, crlfDelay: Infinity });
          // Keep input failures handled even after the iterator is cancelled.
          lines.on("error", () => lines.close());
          for await (const line of lines) {
            if (signal.aborted) break;
            if (line) snapshot(JSON.parse(line));
          }
        } catch {
          // EOF, malformed data, and socket failure all require a fresh snapshot.
        } finally {
          const notify = !signal.aborted;
          controller.abort();
          if (notify) disconnected();
        }
      })();
      return () => controller.abort();
    },
  };
}
