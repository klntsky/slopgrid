import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationClient } from "../server/generation-client.js";
import { generationProtocol } from "../server/generation-api.js";

test(
  "generation transport preserves split Unicode, reports interrupted streams once, and stops buffered delivery on unsubscribe",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-transport-"));
    const socket = join(directory, "engine.sock");
    const title = "Thinking 🧠 ქართულად";
    const first = JSON.stringify({ revision: 1, title }) + "\n";
    const second =
      JSON.stringify({ revision: 2, title: title + " continued" }) + "\n";
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const server = createServer(async (req, res) => {
      res.setHeader("X-Generation-Protocol", String(generationProtocol));
      if (req.url === "/v1/grids/stream/events") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Force HTTP chunks through the middle of multibyte code points and records.
        for (const byte of Buffer.from(first + second)) {
          res.write(Buffer.from([byte]));
          await setImmediate();
        }
        res.write('{"revision":3,"title":"unfinished');
        await setImmediate();
        res.destroy();
      } else if (req.url === "/v1/grids/cancel/events") {
        res.on("close", cancelled);
        res.write(first + second);
      } else if (req.url === "/v1/grids/rejected") {
        res.writeHead(503);
        res.end(JSON.stringify({ code: "DRAINING", error: title }));
      } else if (req.url === "/v1/grids/wrong-protocol") {
        res.setHeader("X-Generation-Protocol", String(generationProtocol + 1));
        res.end("{}");
      } else {
        res.write('{"revision":1');
        await setImmediate();
        res.destroy();
      }
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    server.listen(socket);
    await once(server, "listening");
    const api = generationClient(socket);
    const received: string[] = [];
    let disconnects = 0;
    await new Promise<void>((resolve) => {
      api.subscribeGrid(
        "stream",
        (grid) => received.push(grid.title!),
        () => {
          disconnects++;
          resolve();
        },
      );
    });
    assert.deepEqual(received, [title, title + " continued"]);
    assert.equal(disconnects, 1);
    received.length = 0;
    const unsubscribe = api.subscribeGrid(
      "cancel",
      (grid) => {
        received.push(grid.title!);
        unsubscribe();
      },
      () => {
        disconnects++;
      },
    );
    await cancellation;
    assert.deepEqual(received, [title]);
    assert.equal(disconnects, 1);
    await assert.rejects(api.getGrid("rejected"), {
      code: "DRAINING",
      message: title,
    });
    for (const id of ["wrong-protocol", "interrupted-response"])
      await assert.rejects(api.getGrid(id), { code: "UNAVAILABLE" });
  },
);
