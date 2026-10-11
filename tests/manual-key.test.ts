import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provider } from "../server/provider.js";
import { createApp } from "../server/app.js";
import { manualCredits } from "../server/manual-keys.js";
import type { Cell, GridInput } from "../server/domain.js";

test("manual keys stay out of SQLite, serve queued cells, and require resending after Pause", async () => {
  let remaining: number | null = 12;
  const upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/key")
      res.end(JSON.stringify({ data: { limit_remaining: remaining } }));
    else {
      res.statusCode = 403;
      res.end("{}");
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  class ControlledProvider extends Provider {
    calls: string[] = [];
    release?: () => void;
    override async models() {
      return [
        {
          id: "fixture/text",
          name: "Text",
          text: true,
          image: false,
          reasoning: false,
          reasoningMandatory: false,
        },
      ];
    }
    override async generate(
      key: string,
      _format: GridInput["format"],
      cell: Cell,
      _write: (text: string) => void,
      signal?: AbortSignal,
    ) {
      this.calls.push(key);
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Paused", "AbortError")),
          { once: true },
        );
      });
      return { files: { "index.md": `# ${cell.prompt}` } };
    }
  }
  const provider = new ControlledProvider(`http://127.0.0.1:${upstreamPort}`);
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-key-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { app, store, jobs } = createApp({
    origin,
    outputDomain: "-outputs.example",
    database: join(directory, "db.sqlite"),
    secret: Buffer.alloc(32, 1),
    provider,
    workersMax: 1,
  });
  server.on("request", app);
  let gridId: string | undefined;
  try {
    assert.equal(await manualCredits(provider, "test-manual-key"), 12);
    remaining = null;
    assert.equal(await manualCredits(provider, "test-manual-key"), null);
    remaining = 12;
    const input: GridInput = {
      format: "markdown",
      prompt: "$VARIABLE_ROW $VARIABLE_COLUMN",
      rows: { kind: "variable", values: ["cat", "dog"] },
      columns: { kind: "variable", values: ["hat"] },
      model: "fixture/text",
      effort: "default",
      budgetUsd: 5,
    };
    const response = await fetch(`${origin}/api/grids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-manual-key",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 201);
    gridId = (await response.json()).id;
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.deepEqual(provider.calls, ["test-manual-key"]);
    const session = await fetch(`${origin}/api/session`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await session.json(), { connected: false });
    const rows = store.db.prepare("SELECT data FROM sessions").all() as {
      data: string;
    }[];
    assert.equal(
      rows.some((row) => Object.hasOwn(JSON.parse(row.data), "key")),
      false,
    );
    provider.release!();
    while (provider.calls.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(provider.calls, ["test-manual-key", "test-manual-key"]);
    await fetch(`${origin}/api/grids/${gridId}/pause`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const retry = await fetch(`${origin}/api/grids/${gridId}/retry`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(retry.status, 401);
  } finally {
    if (gridId) jobs.pause(store.get(gridId)!);
    await new Promise((resolve) => setImmediate(resolve));
    store.db.close();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});
