import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { type RequestListener, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { startGenerationFixture } from "./generation-fixture.js";
import { Store } from "../server/store.js";
import { expandGrid, type Grid } from "../server/domain.js";
import { token } from "../server/ids.js";
import { webFixture } from "./web-fixture.js";
import { seedTestDatabase } from "./database-fixture.js";
import { insertCurrentGrid, validatedGrid } from "./grid-storage-fixture.js";
import {
  currentInput,
  type CurrentGridOverrides,
} from "./current-grid-fixture.js";

export type CapturedRequest = {
  model: string;
  messages: {
    role: string;
    content:
      string | { type: string; text?: string; image_url?: { url: string } }[];
    reasoning_details?: Record<string, unknown>[];
  }[];
  max_tokens?: number;
  modalities?: string[];
  reasoning?: { effort?: string };
  provider?: { max_price?: Record<string, number> };
  response_format?: {
    json_schema: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
  };
};

export type CapturedImageRequest = {
  model: string;
  prompt: string;
  [parameter: string]: unknown;
};
export function messageText(
  content: CapturedRequest["messages"][number]["content"],
): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text ?? "").join("");
}

export async function until<T>(
  read: () => Promise<T> | T,
  ready: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("State transition did not finish");
}
export async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

type RuntimeCatalog = {
  data: {
    id: string;
    name: string;
    alias_target?: { slug: string };
    pricing: { prompt: string; completion: string };
    context_length: number;
    top_provider: { max_completion_tokens: number };
    architecture: { input_modalities: string[]; output_modalities: string[] };
    supported_parameters: string[];
  }[];
};
export type GridReadFault =
  | {
      kind: "json";
      status: number;
      code: string;
      retryAfter?: string;
    }
  | { kind: "html"; status: number; retryAfter?: string }
  | { kind: "reset" }
  | { kind: "stall" };

function gridTransport() {
  const controls = new Map<
    string,
    {
      faults: GridReadFault[];
      fallback: GridReadFault | undefined;
      reads: number;
      mutations: number;
      eventsBlocked: boolean;
      events: Set<ServerResponse>;
      readers: Map<number, (() => void)[]>;
    }
  >();
  function forGrid(id: string) {
    let state = controls.get(id);
    if (!state) {
      state = {
        faults: [],
        fallback: undefined,
        reads: 0,
        mutations: 0,
        eventsBlocked: false,
        events: new Set(),
        readers: new Map(),
      };
      controls.set(id, state);
    }
    const current = state;
    return {
      get reads() {
        return current.reads;
      },
      get mutations() {
        return current.mutations;
      },
      fail(faults: GridReadFault[], fallback?: GridReadFault) {
        current.faults = [...faults];
        current.fallback = fallback;
      },
      pass() {
        current.faults = [];
        current.fallback = undefined;
      },
      blockEvents(blocked = true) {
        current.eventsBlocked = blocked;
        if (blocked) for (const response of current.events) response.destroy();
      },
      waitForRead(count: number) {
        if (current.reads >= count) return Promise.resolve();
        const { promise, resolve } = Promise.withResolvers<void>();
        const readers = current.readers.get(count) ?? [];
        readers.push(resolve);
        current.readers.set(count, readers);
        return promise;
      },
    };
  }
  const intercept = ((
    request: Parameters<RequestListener>[0],
    response: Parameters<RequestListener>[1],
  ) => {
    const path = request.url?.split("?")[0];
    for (const [id, state] of controls) {
      const gridPath = `/api/grids/${id}`;
      if (path !== gridPath && !path?.startsWith(`${gridPath}/`)) continue;
      if (request.method !== "GET") {
        state.mutations++;
        return false;
      }
      if (path === `${gridPath}/events`) {
        if (state.eventsBlocked) {
          response.writeHead(503).end();
          return true;
        }
        state.events.add(response);
        response.once("close", () => state.events.delete(response));
        return false;
      }
      if (path !== gridPath) return false;
      state.reads++;
      for (const resolve of state.readers.get(state.reads) ?? []) resolve();
      state.readers.delete(state.reads);
      const fault = state.faults.shift() ?? state.fallback;
      if (!fault) return false;
      if (fault.kind === "reset") {
        request.socket.destroy();
        return true;
      }
      if (fault.kind === "stall") {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.write('{"id":');
        return true;
      }
      response.writeHead(fault.status, {
        "content-type":
          fault.kind === "json" ? "application/json" : "text/html",
        "cache-control": "no-store",
        ...(fault.retryAfter ? { "retry-after": fault.retryAfter } : {}),
      });
      response.end(
        fault.kind === "json"
          ? JSON.stringify({
              error: "Controlled grid read failure",
              code: fault.code,
            })
          : "<!doctype html><title>Upstream temporarily unavailable</title>",
      );
      return true;
    }
    return false;
  }) satisfies NonNullable<Parameters<typeof webFixture>[0]["intercept"]>;
  return { forGrid, intercept };
}

/** Real service processes with a controllable external HTTP provider. */
export async function runtimeFixture(
  options: {
    workers?: number;
    judges?: boolean;
    images?: boolean;
    chatImages?: boolean;
    configureCatalog?: (catalog: RuntimeCatalog) => void;
    observeRequest?: RequestListener;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-runtime-"));
  const database = join(directory, "app.sqlite"),
    secret = Buffer.alloc(32, 9);
  await seedTestDatabase(database);
  const store = await Store.open(database, secret);
  const transport = gridTransport();
  const owner = token();
  store.saveSession({ id: owner, key: "manual-test-key", created: Date.now() });
  const upstream = express();
  upstream.use(express.json({ limit: "64mb" }));
  const catalog: RuntimeCatalog = {
    data: [
      {
        id: "fixture/text",
        name: "Fixture",
        pricing: { prompt: "0.000001", completion: "0.000001" },
        context_length: 100000,
        top_provider: { max_completion_tokens: 1000 },
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning", "structured_outputs"],
      },
      ...(options.chatImages
        ? [
            {
              id: "fixture/multimodal",
              name: "Fixture multimodal",
              pricing: { prompt: "0.000001", completion: "0.000001" },
              context_length: 100000,
              top_provider: { max_completion_tokens: 1000 },
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text", "image"],
              },
              supported_parameters: ["reasoning", "structured_outputs"],
            },
            {
              id: "fixture/image-only",
              name: "Fixture image only",
              pricing: { prompt: "0", completion: "0" },
              context_length: 100000,
              top_provider: { max_completion_tokens: 1000 },
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["image"],
              },
              supported_parameters: [],
            },
            {
              id: "~fixture/image-latest",
              name: "Fixture image alias",
              alias_target: { slug: "fixture/image-only" },
              pricing: { prompt: "0", completion: "0" },
              context_length: 100000,
              top_provider: { max_completion_tokens: 1000 },
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              supported_parameters: [],
            },
          ]
        : []),
      ...(options.judges
        ? [
            {
              id: "fixture/judge-other",
              name: "Other judge",
              pricing: { prompt: "0.000001", completion: "0.000001" },
              context_length: 100000,
              top_provider: { max_completion_tokens: 1000 },
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              supported_parameters: ["reasoning", "structured_outputs"],
            },
          ]
        : []),
    ],
  };
  // Seed catalog variations before either service can cache the model list.
  options.configureCatalog?.(catalog);
  const credits = { total_credits: 100, total_usage: 0 };
  const providerImageRequests: string[] = [];
  upstream.get("/provider-image-must-not-be-fetched.png", (req, res) => {
    providerImageRequests.push(req.path);
    res.sendStatus(418);
  });
  upstream.get("/models", (_req, res) => res.json(catalog));
  upstream.get("/images/models", (_req, res) =>
    res.json({
      data: options.images
        ? [
            {
              id: "fixture/image",
              name: "Fixture image",
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["image"],
              },
              supported_parameters: { n: { type: "integer" } },
            },
          ]
        : [],
    }),
  );
  upstream.get("/images/models/fixture/image/endpoints", (_req, res) =>
    res.json({
      endpoints: [
        {
          provider_name: "Fixture provider",
          pricing: [
            { billable: "output_image", unit: "image", cost_usd: 0.04 },
          ],
          supported_parameters: { n: { type: "integer" } },
        },
      ],
    }),
  );
  upstream.get("/credits", (_req, res) => res.json({ data: credits }));
  upstream.get("/key", (_req, res) =>
    res.json({ data: { limit_remaining: 100 } }),
  );
  const calls: {
    request: CapturedRequest;
    prompt: string;
    aborted: boolean;
    closed: Promise<void>;
    write: (delta: object) => void;
    finish: (
      cost?: number,
      completion?: {
        reason: string;
        outputTokens: number;
        reasoningTokens?: number;
      },
    ) => void;
    fail: (status?: number) => void;
    disconnect: () => void;
  }[] = [];
  const imageCalls: {
    request: CapturedImageRequest;
    aborted: boolean;
    finish: (bytes: Uint8Array, cost?: number) => void;
    fail: (status?: number) => void;
  }[] = [];
  upstream.post("/images", (req, res) => {
    const call = {
      request: req.body as CapturedImageRequest,
      aborted: false,
      finish: (bytes: Uint8Array, cost = 0.04) =>
        res.json({
          created: 1,
          data: [{ b64_json: Buffer.from(bytes).toString("base64") }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cost,
          },
        }),
      fail: (status = 429) =>
        res.status(status).json({
          error: { code: status, message: "Controlled image provider failure" },
        }),
    };
    res.on("close", () => {
      if (!res.writableEnded) call.aborted = true;
    });
    imageCalls.push(call);
  });
  upstream.post("/chat/completions", (req, res) => {
    const id = `call-${calls.length}`;
    const event = (
      delta: object,
      finish_reason: string | null = null,
      usage?: object,
    ) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: req.body.model, choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`,
      );
    res.type("text/event-stream");
    res.flushHeaders();
    const call = {
      request: req.body,
      prompt: (req.body as CapturedRequest).messages
        .filter((message) => message.role === "user")
        .map((message) => messageText(message.content))
        .join(""),
      aborted: false,
      closed: new Promise<void>((resolve) => {
        res.once("close", () => resolve());
      }),
      disconnect: () => res.destroy(),
      write: (delta: object) => {
        event(delta);
      },
      finish: (
        cost = 0.0123,
        completion?: {
          reason: string;
          outputTokens: number;
          reasoningTokens?: number;
        },
      ) => {
        const outputTokens = completion?.outputTokens ?? 20;
        event({}, completion?.reason ?? "stop", {
          prompt_tokens: 10,
          completion_tokens: outputTokens,
          ...(completion?.reasoningTokens !== undefined && {
            completion_tokens_details: {
              reasoning_tokens: completion.reasoningTokens,
            },
          }),
          total_tokens: 10 + outputTokens,
          cost,
        });
        res.end("data: [DONE]\n\n");
      },
      fail: (status = 429) =>
        res.end(
          `data: ${JSON.stringify({ error: { code: status, message: "Controlled provider failure" } })}\n\ndata: [DONE]\n\n`,
        ),
    };
    res.on("close", () => {
      if (!res.writableEnded) call.aborted = true;
    });
    calls.push(call);
  });
  const upstreamServer = upstream.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  const providerURL = `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`;
  let engine: Awaited<ReturnType<typeof startGenerationFixture>>;
  let web: Awaited<ReturnType<typeof webFixture>> | undefined,
    origin = "",
    port = 0;
  async function startEngine() {
    engine = await startGenerationFixture({
      database,
      secret,
      providerURL,
      workersMax: options.workers ?? 1,
    });
  }
  async function startWeb(socket = database + ".sock") {
    await web?.close();
    web = await webFixture({
      database,
      socket,
      secret,
      providerURL,
      port,
      intercept: (request, response) => {
        options.observeRequest?.(request, response);
        return transport.intercept(request, response);
      },
    });
    origin = web.origin;
    port = Number(new URL(origin).port);
  }
  async function close() {
    await web?.close();
    if (engine!) await engine.close();
    upstreamServer.closeAllConnections();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    await startEngine();
    await startWeb();
  } catch (error) {
    await close();
    throw error;
  }
  let nextCallIndex = 0,
    nextImageCallIndex = 0;
  return {
    nextCall: () => {
      const index = nextCallIndex++;
      return until(() => calls[index], Boolean);
    },
    nextImageCall: () => {
      const index = nextImageCallIndex++;
      return until(() => imageCalls[index], Boolean);
    },
    catalog,
    providerURL,
    credits,
    directory,
    database,
    store,
    owner,
    calls,
    imageCalls,
    providerImageRequests,
    gridTransport: transport.forGrid,
    close,
    startWeb,
    startEngine,
    get engine() {
      return engine;
    },
    get web() {
      return web!.child;
    },
    get origin() {
      return origin;
    },
    get backendOrigin() {
      return web!.backendOrigin;
    },
    cookie: `__Host-slopgrid=${owner}`,
    cookieName: "__Host-slopgrid",
    fetch: (url: string, init?: RequestInit) => web!.fetch(url, init),
    request: (path: string, body?: unknown, method = "POST") =>
      web!.fetch(origin + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          cookie: `__Host-slopgrid=${owner}`,
          origin,
          authorization: "Bearer manual-test-key",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    grid(overrides: CurrentGridOverrides = {}) {
      // A complete current definition must not inherit this helper's variable axis.
      const input =
        overrides.inputVersion === 3
          ? currentInput(overrides)
          : currentInput({
              caseAxes: ["rows"],
              rows: [
                { variable: [{ text: "cat" }] },
                { variable: [{ text: "dog" }] },
              ],
              columns: [{ model: "fixture/text" }],
              budgetUsd: 0.1,
              parallelWorkers: 1,
              ...overrides,
              parameters: {
                input: {
                  kind: "common",
                  value: [{ role: "user", content: "Draw $ROW1" }],
                },
                model: { kind: "columns" },
                effort: { kind: "common", value: "none" },
                ...overrides.parameters,
              },
            });
      const grid: Grid = {
        id: token(),
        owner,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((c) => ({ ...c, id: token() })),
      };
      insertCurrentGrid(store, validatedGrid(grid));
      return grid;
    },
    call: (index: number) => until(() => calls[index], Boolean),
  };
}

export type RuntimeFixture = Awaited<ReturnType<typeof runtimeFixture>>;
export type RuntimeCall = RuntimeFixture["calls"][number];
