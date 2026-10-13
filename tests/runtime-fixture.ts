import { fork, type ChildProcess, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { startGenerationFixture } from "./generation-fixture.js";
import { Store } from "../server/store.js";
import { expandGrid, type GridInput, type Grid } from "../server/domain.js";
import { token } from "../server/ids.js";

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

/** The deployment mock is controlled by the test, including each streaming delta. */
export async function runtimeFixture(
  options: { tls?: boolean; workers?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-runtime-"));
  const preparation = join(directory, "preparation.json");
  writeFileSync(preparation, "{}");
  const database = join(directory, "app.sqlite"),
    secret = Buffer.alloc(32, 9);
  const store = new Store(database, secret);
  const owner = token();
  store.saveSession({ id: owner, key: "manual-test-key", created: Date.now() });
  const upstream = express();
  upstream.use(express.json());
  const catalog = {
    data: [
      {
        id: "fixture/text",
        name: "Fixture",
        pricing: { prompt: "0.000001", completion: "0.000001" },
        context_length: 100000,
        top_provider: { max_completion_tokens: 1000 },
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: ["reasoning", "structured_outputs"],
      },
    ],
  };
  const credits = { total_credits: 100, total_usage: 0 };
  upstream.get("/models", (_req, res) => res.json(catalog));
  upstream.get("/images/models", (_req, res) => res.json({ data: [] }));
  upstream.get("/credits", (_req, res) => res.json({ data: credits }));
  upstream.get("/key", (_req, res) =>
    res.json({ data: { limit_remaining: 100 } }),
  );
  const calls: {
    request: Record<string, any>;
    prompt: string;
    aborted: boolean;
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
  }[] = [];
  upstream.post("/chat/completions", (req, res) => {
    const id = `call-${calls.length}`;
    const event = (
      delta: object,
      finish_reason: string | null = null,
      usage?: object,
    ) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "fixture/text", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`,
      );
    res.type("text/event-stream");
    res.flushHeaders();
    const call = {
      request: req.body,
      prompt: JSON.stringify(
        req.body.messages.filter((m: { role: string }) => m.role === "user"),
      ),
      aborted: false,
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
  let web: ChildProcess | undefined,
    origin = "",
    port = 0;
  async function startEngine() {
    engine = await startGenerationFixture({
      database,
      secret,
      preparation,
      providerURL,
      workersMax: options.workers ?? 1,
    });
  }
  async function startWeb(socket = database + ".sock") {
    web = fork(join(process.cwd(), "tests/web-process.ts"), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        DATABASE_PATH: database,
        GENERATION_SOCKET: socket,
        KEY_ENCRYPTION_SECRET: secret.toString("hex"),
        OPENROUTER_BASE_URL: providerURL,
        FIXTURE_PREPARATION: preparation,
        FIXTURE_PORT: String(port),
        FIXTURE_TLS: options.tls ? directory : undefined,
      },
    });
    origin = String(
      (
        await Promise.race([
          once(web, "message"),
          once(web, "exit").then(() => {
            throw new Error("Web fixture exited");
          }),
        ])
      )[0],
    );
    port = Number(new URL(origin).port);
  }
  async function close() {
    if (web) await kill(web);
    if (engine!) await engine.close();
    upstreamServer.closeAllConnections();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    if (options.tls)
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=slopgrid.test",
        ],
        { stdio: "ignore" },
      );
    await startEngine();
    await startWeb();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    prepare(change: object) {
      writeFileSync(preparation, JSON.stringify(change));
    },
    catalog,
    credits,
    directory,
    database,
    store,
    owner,
    calls,
    close,
    startWeb,
    startEngine,
    get engine() {
      return engine;
    },
    get web() {
      return web!;
    },
    get origin() {
      return origin;
    },
    request: (path: string, body?: unknown, method = "POST") =>
      fetch(origin + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          cookie: `slopgrid=${owner}`,
          origin,
          authorization: "Bearer manual-test-key",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    grid(overrides: Partial<GridInput> = {}) {
      const input: GridInput = {
        format: "markdown",
        prompt: "Draw $ROW",
        rows: { kind: "variable", values: ["cat", "dog"] },
        columns: { kind: "model", values: ["fixture/text"] },
        model: "",
        effort: "none",
        budgetUsd: 0.1,
        parallelWorkers: 1,
        ...overrides,
      };
      const grid: Grid = {
        id: token(),
        revision: 0,
        owner,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((c) => ({ ...c, id: token() })),
      };
      store.insert(grid);
      return grid;
    },
    call: (index: number) => until(() => calls[index], Boolean),
  };
}
