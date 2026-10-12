import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "./generation-fixture.js";
import { Store } from "../server/store.js";
import type { Grid } from "../server/domain.js";

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("State transition did not finish");
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test(
  "web replacement preserves live calls, thinking, billing and metadata; draining fences new work and finishes the queue",
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-deploy-"));
    const database = join(directory, "app.sqlite"),
      secret = Buffer.alloc(32, 9);
    const upstream = express();
    upstream.use(express.json());
    upstream.get("/models", (_req, res) =>
      res.json({
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
            supported_parameters: ["reasoning"],
          },
        ],
      }),
    );
    upstream.get("/images/models", (_req, res) => res.json({ data: [] }));
    upstream.get("/credits", (_req, res) =>
      res.json({ data: { total_credits: 100, total_usage: 0 } }),
    );
    upstream.get("/key", (_req, res) =>
      res.json({ data: { limit_remaining: 100 } }),
    );
    const calls: {
      response: express.Response;
      finish: () => void;
      write: () => void;
    }[] = [];
    let aborted = 0;
    upstream.post("/chat/completions", (req, res) => {
      assert.equal(req.get("authorization"), "Bearer manual-test-key");
      res.type("text/event-stream");
      const event = (
        delta: object,
        finish_reason: string | null = null,
        usage?: object,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id: `call-${calls.length}`, object: "chat.completion.chunk", created: 1, model: "fixture/text", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`,
        );
      event({
        reasoning: "Persistent thinking. ",
        content: "Before deployment. ",
      });
      res.on("close", () => {
        if (!res.writableEnded) aborted++;
      });
      calls.push({
        response: res,
        write: () =>
          event({ reasoning: "More thinking.", content: "After deployment." }),
        finish: () => {
          event({}, "stop", {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cost: 0.0123,
          });
          res.end("data: [DONE]\n\n");
        },
      });
    });
    const upstreamServer = upstream.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const providerURL = `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`;
    let engine: Awaited<ReturnType<typeof startGenerationFixture>> | undefined;
    let web: ChildProcess | undefined;
    let store: Store | undefined;
    let origin = "";
    async function startWeb() {
      web = fork(join(process.cwd(), "tests/web-process.ts"), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          DATABASE_PATH: database,
          GENERATION_SOCKET: database + ".sock",
          KEY_ENCRYPTION_SECRET: secret.toString("hex"),
          OPENROUTER_BASE_URL: providerURL,
        },
      });
      origin = String((await once(web, "message"))[0]);
    }
    try {
      engine = await startGenerationFixture({
        database,
        secret,
        providerURL,
        workersMax: 1,
      });
      const instance = (await engine.api.status()).instance;
      await startWeb();
      const sessionResponse = await fetch(origin + "/api/session");
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0];
      const request = (path: string, body?: unknown, method = "POST") =>
        fetch(origin + path, {
          method: body === undefined ? "GET" : method,
          headers: {
            cookie,
            origin,
            authorization: "Bearer manual-test-key",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const input = {
        format: "markdown",
        prompt: "Draw $ROW",
        rows: { kind: "variable", values: ["cat", "dog"] },
        columns: { kind: "model", values: ["fixture/text"] },
        model: "",
        effort: "none",
        budgetUsd: 0.1,
        parallelWorkers: 1,
      };
      const created = await request("/api/grids", input);
      assert.equal(created.status, 201, await created.clone().text());
      const grid = (await created.json()) as Grid;
      await until(
        () => engine!.api.getGrid(grid.id),
        (g) => !!g.cells[0].thinking,
      );
      const subscription = await request(`/api/grids/${grid.id}/events`);
      const reader = subscription.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /Persistent thinking/,
      );
      await reader.cancel();
      await kill(web!);
      await startWeb();
      assert.equal((await engine.api.status()).instance, instance);
      const restored = await (await request(`/api/grids/${grid.id}`)).json();
      assert.equal(restored.cells[0].draft, "Before deployment. ");
      assert.equal(restored.cells[0].thinking, "Persistent thinking. ");
      assert.equal(calls.length, 1);
      assert.equal(aborted, 0);
      assert.equal((await (await request("/api/billing")).json()).running, 1);
      assert.equal(
        (
          await request(
            `/api/grids/${grid.id}/title`,
            { title: "Changed during inference" },
            "PATCH",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(`/api/grids/${grid.id}/publish`, {
            visibility: "public",
          })
        ).status,
        409,
      );
      // Claiming metadata from the web connection must survive the engine's stale object.
      store = new Store(database, secret);
      store.claim(
        grid.owner ?? cookie.slice("slopgrid=".length),
        "claimed-account",
      );
      calls[0].write();
      const drained = await engine.api.drain();
      assert.equal(drained.runningCalls, 1);
      assert.equal(drained.activeGrids, 1);
      // Starting an unrelated grid while draining is rejected inside the engine.
      const blocked = {
        ...store.get(grid.id)!,
        id: "blocked",
        ownerUserId: undefined,
        status: "paused" as const,
        cells: store
          .get(grid.id)!
          .cells.map((cell, i) => ({
            ...cell,
            id: `blocked-${i}`,
            status: "pending" as const,
          })),
      };
      store.insert(blocked);
      await assert.rejects(
        engine.api.startGrid({
          gridId: blocked.id,
          sessionId: cookie.slice("slopgrid=".length),
          manualKey: "manual-test-key",
        }),
        { code: "DRAINING" },
      );
      calls[0].finish();
      await until(
        async () => calls.length,
        (n) => n === 2,
      );
      assert.equal((await engine.api.status()).runningCalls, 1);
      calls[1].finish();
      await until(
        () => engine!.api.status(),
        (s) => s.runningCalls === 0 && s.activeGrids === 0,
      );
      const completed = await engine.api.getGrid(grid.id);
      assert.equal(completed.title, "Changed during inference");
      assert.equal(completed.ownerUserId, "claimed-account");
      assert.equal(completed.status, "complete");
      assert.equal(
        readFileSync(
          store.files.path(completed.cells[0].id, "index.md")!,
          "utf8",
        ),
        "Before deployment. After deployment.",
      );
      assert.equal(
        readFileSync(
          store.files.thinkingPath(
            completed.cells[0].id,
            completed.cells[0].thinkingId!,
          )!,
          "utf8",
        ),
        "Persistent thinking. More thinking.",
      );
      assert.equal(
        store.billing.page(completed.owner, 0, "claimed-account").costUsd,
        0.0246,
      );
      assert.equal(aborted, 0);
      // A machinery restart recovers only interrupted work and cannot replay completed calls.
      await engine.close();
      engine = await startGenerationFixture({
        database,
        secret,
        providerURL,
        workersMax: 1,
      });
      assert.notEqual((await engine.api.status()).instance, instance);
      assert.equal((await engine.api.getGrid(grid.id)).status, "complete");
      assert.equal(calls.length, 2);
    } finally {
      if (web) await kill(web);
      if (engine) await engine.close();
      upstreamServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
      store?.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
