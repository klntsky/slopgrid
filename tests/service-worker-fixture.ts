import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ViewGrid } from "../src/api";

const origin = "https://slopgrid.test";
const key = (request: Request | string) =>
  new URL(typeof request === "string" ? request : request.url, origin).href;

class WorkerCache {
  private entries = new Map<string, Response>();

  async match(request: Request | string) {
    return this.entries.get(key(request))?.clone();
  }

  async put(request: Request | string, response: Response) {
    this.entries.set(key(request), response.clone());
  }

  async delete(request: Request | string) {
    return this.entries.delete(key(request));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class WorkerStorage {
  private entries = new Map<string, WorkerCache>();

  async open(name: string) {
    let cache = this.entries.get(name);
    if (!cache) {
      cache = new WorkerCache();
      this.entries.set(name, cache);
    }
    return cache;
  }

  async keys() {
    return [...this.entries.keys()];
  }

  async delete(name: string) {
    return this.entries.delete(name);
  }
}

// Execute the shipped fetch/message handlers, retaining CacheStorage across
// worker restarts while discarding worker globals just as the browser does.
type WorkerEvent = Record<string, unknown> & {
  waitUntil(work: Promise<unknown>): void;
  respondWith(work: Promise<Response>): void;
};
export function serviceWorkerFixture(
  fetch: (request: Request) => Promise<Response>,
  caches = new WorkerStorage(),
) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  let clientAlive = true;
  let sweepClients: (() => Promise<void>) | undefined;
  const source = readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  )
    .replace("__PWA_ASSETS__", "[]")
    .replace("__PWA_VERSION__", '"test"')
    .replace("__PWA_POLICY__", '"default-src self"');
  runInNewContext(source, {
    self: {
      location: { origin },
      clients: {
        claim: async () => {},
        get: async () => (clientAlive ? { id: "fixture-client" } : undefined),
      },
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) =>
        handlers.set(type, handler),
    },
    caches,
    fetch: (request: Request | string) =>
      fetch(typeof request === "string" ? new Request(key(request)) : request),
    Request,
    Response,
    Headers,
    URL,
    AbortController,
    ReadableStream,
    setInterval: (work: () => Promise<void>) => {
      sweepClients = work;
      return 1;
    },
    clearInterval: () => {
      sweepClients = undefined;
    },
  });

  function dispatch(type: string, data: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)!({
      ...data,
      waitUntil: (work: Promise<unknown>) => pending.push(work),
      respondWith: (work: Promise<Response>) => {
        response = work;
      },
    });
    return {
      response,
      async settled() {
        for (let index = 0; index < pending.length; index++)
          await pending[index];
      },
    };
  }

  return {
    caches,
    closeClient() {
      clientAlive = false;
    },
    sweepClients() {
      return sweepClients?.();
    },
    activate() {
      return dispatch("activate", {}).settled();
    },
    fetch(path: string, method = "GET", readId?: string) {
      return dispatch("fetch", {
        clientId: "fixture-client",
        request: new Request(key(path), {
          method,
          headers: readId ? { "X-Slopgrid-Grid-Read": readId } : undefined,
        }),
      });
    },
    cancelGridRead(id: string) {
      return dispatch("message", {
        source: { url: origin, id: "fixture-client" },
        data: { type: "cancel-grid-read", id },
      }).settled();
    },
    retainGrid(
      grid: Pick<ViewGrid, "id"> & {
        cells: Pick<
          ViewGrid["cells"][number],
          "id" | "generationId" | "status" | "outputReady" | "judge"
        >[];
      },
    ) {
      return dispatch("message", {
        source: { url: origin },
        data: {
          type: "cache-grid",
          id: grid.id,
          completed: grid.cells
            .filter((cell) => cell.outputReady || cell.status === "complete")
            .map((cell) => ({
              id: cell.id,
              generationId: cell.generationId,
              judgment:
                cell.judge?.status === "complete" ||
                cell.judge?.status === "error"
                  ? {
                      status: cell.judge.status,
                      attemptId: cell.judge.attemptId,
                    }
                  : undefined,
            })),
        },
      }).settled();
    },
  };
}
