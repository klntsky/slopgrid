import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { applyDelta } from "../shared/grid-delta.js";
import { createStreamHistory } from "../server/stream-history.js";

test("reconnect history is viewer-scoped, expires, and obeys its memory budget", () => {
  let time = 0;
  const history = createStreamHistory<string>(10, 100, () => time);
  const first = history.put("owner:grid", "private", 6);
  assert.equal(history.get(first, "other:grid"), undefined);
  assert.equal(history.get(first, "owner:grid"), "private");
  const second = history.put("owner:grid", "next", 6);
  assert.equal(history.get(first, "owner:grid"), undefined);
  assert.equal(history.get(second, "owner:grid"), "next");
  time = 100;
  assert.equal(history.get(second, "owner:grid"), undefined);
  const oversized = history.put("owner:grid", "large", 11);
  assert.equal(history.get(oversized, "owner:grid"), undefined);
});

test(
  "events send small live and reconnect deltas, and recover an unknown cursor with one snapshot",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    async function connect(id: string, since = "") {
      const response = await f.request(
        `/api/grids/${id}/events?protocol=2&since=${since}`,
      );
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      readers.push(reader);
      let buffer = "";
      const decoder = new TextDecoder();
      return {
        close: () => reader.cancel(),
        async next() {
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame
                .split("\n")
                .find((line) => line.startsWith("data: "));
              if (data)
                return {
                  cursor: frame
                    .split("\n")
                    .find((line) => line.startsWith("id: "))!
                    .slice(4),
                  message: JSON.parse(data.slice(6)),
                  bytes: Buffer.byteLength(frame),
                };
              continue;
            }
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        },
      };
    }
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      const prefix = "Previous output and thinking. ".repeat(10000);
      call.write({ content: prefix, reasoning: prefix });
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.cells[0].draft === prefix,
      );
      const stream = await connect(grid.id);
      const initial = await stream.next();
      let state = initial.message.snapshot;
      assert.equal(state.cells[0].draft, prefix);
      call.write({ content: " live", reasoning: " thought" });
      let event;
      do {
        event = await stream.next();
        assert.equal(event.message.base, initial.cursor);
        state = applyDelta(state, event.message.delta);
      } while (state.cells[0].draft !== prefix + " live");
      assert.ok(event.bytes < 4000, `live frame was ${event.bytes} bytes`);
      const cursor = event.cursor;
      await stream.close();
      call.write({ content: " disconnected", reasoning: " recovered" });
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.cells[0].draft?.endsWith(" disconnected") === true,
      );
      const resumed = await connect(grid.id, cursor);
      const recovery = await resumed.next();
      assert.equal(recovery.message.base, cursor);
      assert.ok(
        recovery.bytes < 4000,
        `recovery frame was ${recovery.bytes} bytes`,
      );
      state = applyDelta(state, recovery.message.delta);
      assert.equal(state.cells[0].draft, prefix + " live disconnected");
      assert.equal(state.cells[0].thinking, prefix + " thought recovered");
      await resumed.close();
      const fallback = await connect(grid.id, "unknown");
      const fresh = await fallback.next();
      assert.equal(fresh.message.snapshot.cells[0].draft, state.cells[0].draft);
      await fallback.close();
      call.finish();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      assert.equal(f.calls.length, 1);
      assert.equal(call.aborted, false);
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => {});
      await f.close();
    }
  },
);
