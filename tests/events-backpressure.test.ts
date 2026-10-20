import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { serveGeneration } from "../server/generation-server.js";
import type { GenerationSnapshot } from "../server/generation-api.js";
import { applyDelta, type GridStreamMessage } from "../shared/grid-delta.js";
import { runtimeFixture } from "./runtime-fixture.js";

for (const size of [1024, 1024 * 1024]) {
  test(
    `an actively reading SSE viewer receives a burst with ${size}-byte drafts without reconnecting`,
    { timeout: 20000 },
    async (t) => {
      const f = await runtimeFixture();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let publish: ((grid: GenerationSnapshot) => void) | undefined;
      const grid = f.grid({
        rows: { kind: "variable", values: [[{ text: "cat" }]] },
      });
      let current: GenerationSnapshot = {
        ...(await f.engine.api.getGrid(grid.id)),
        live: true,
      };
      const socket = join(f.directory, "burst.sock");
      // Control only notification timing; use the real engine transport, web
      // process, SSE framing and delta application, with an actively read socket.
      const server = await serveGeneration(
        {
          ...f.engine.api,
          getGrid: async () => current,
          subscribeGrid(_id, snapshot) {
            publish = snapshot;
            snapshot(current);
            return () => {
              publish = undefined;
            };
          },
        },
        socket,
      );
      try {
        await f.startWeb(socket);
        const response = await f.request(
          `/api/grids/${grid.id}/events?protocol=2`,
        );
        assert.equal(response.status, 200);
        reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let cursor = "";
        let state: GenerationSnapshot | undefined;
        let frames = 0;
        async function next() {
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary >= 0) {
              const lines = buffer.slice(0, boundary).split("\n");
              buffer = buffer.slice(boundary + 2);
              const data = lines.find((line) => line.startsWith("data: "));
              if (!data) continue;
              const message: GridStreamMessage<GenerationSnapshot> = JSON.parse(
                data.slice(6),
              );
              if ("snapshot" in message) state = message.snapshot;
              else {
                assert.equal(message.base, cursor);
                state = applyDelta(state, message.delta) as GenerationSnapshot;
              }
              cursor = lines.find((line) => line.startsWith("id: "))!.slice(4);
              frames++;
              return state;
            }
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await reader!.read();
            } catch (error) {
              assert.fail(
                `SSE connection failed after ${frames} frames before the latest update: ${error}`,
              );
            }
            assert.equal(
              chunk.done,
              false,
              `SSE connection ended after ${frames} frames before the latest update`,
            );
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        }
        await next();
        assert.ok(publish);
        const initialSequence = current.version.sequence;
        const draft = "x".repeat(size);
        // Dispatch and settlement can notify in the same turn. Do not wait for
        // receipt between notifications: that would hide transient backpressure.
        for (let sequence = 1; sequence <= 2; sequence++) {
          current = {
            ...current,
            version: {
              ...current.version,
              sequence: initialSequence + sequence,
            },
            cells: current.cells.map((cell) => ({
              ...cell,
              draft: draft + sequence,
            })),
          };
          publish(current);
        }
        while (state!.version.sequence < current.version.sequence) await next();
        assert.equal(state!.cells[0].draft, draft + "2");
        assert.equal(f.calls.length, 0);
        t.diagnostic(
          `Received latest state on one connection (${frames} frames)`,
        );
      } finally {
        await reader?.cancel().catch(() => {});
        await f.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
