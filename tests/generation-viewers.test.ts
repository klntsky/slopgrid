import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type IncomingMessage, type RequestOptions } from "node:http";
import { request as secureRequest } from "node:https";
import { readFileSync } from "node:fs";
import type { Grid } from "../server/domain.js";
import { runtimeFixture, until } from "./runtime-fixture.js";

async function stalled(options: RequestOptions) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = (options.socketPath ? request : secureRequest)(
      { ...options, rejectUnauthorized: false },
      (res) => {
        res.on("error", () => {});
        res.pause();
        resolve(res);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test(
  "a stalled engine viewer recovers independently while stalled web viewers release capacity",
  { timeout: 30000 },
  async () => {
    const f = await runtimeFixture();
    const slow: IncomingMessage[] = [];
    let slowEngine: IncomingMessage | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<void> | undefined;
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      const endpoint = `/api/grids/${grid.id}/events`;
      const healthy = await f.request(endpoint);
      reader = healthy.body!.getReader();
      let latest: Grid | undefined;
      reading = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader!.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (event.startsWith("data: ")) latest = JSON.parse(event.slice(6));
          }
        }
      })();
      void reading.catch(() => {});
      await until(() => latest, Boolean);
      const url = new URL(f.origin);
      for (let index = 0; index < 4; index++)
        slow.push(
          await stalled({
            hostname: url.hostname,
            port: url.port,
            path: endpoint,
            headers: { cookie: f.cookie },
          }),
        );
      assert.equal((await f.request(endpoint)).status, 429);
      slowEngine = await stalled({
        socketPath: f.database + ".sock",
        path: `/v1/grids/${grid.id}/events`,
      });
      // Paused readers stop draining their actual sockets. Successive snapshots
      // exceed socket buffers while the healthy client acknowledges each update.
      const chunk = "Streaming payload. ".repeat(30000);
      for (let index = 1; index <= 8; index++) {
        call.write({ content: chunk });
        await until(
          () => latest,
          (g) => g?.cells[0].draft?.length === chunk.length * index,
        );
      }
      const replacement = await f.request(endpoint);
      assert.equal(
        replacement.status,
        200,
        "slow viewers must release admission capacity",
      );
      await replacement.body!.cancel();
      for (const response of slow) response.resume();
      await until(() => slow.every((response) => response.destroyed), Boolean);
      assert.equal(
        slow.every((response) => !response.complete),
        true,
        "stalled web subscriptions must release capacity",
      );
      assert.equal(slowEngine.destroyed, false);
      let recovered: Grid | undefined;
      let engineBuffer = "";
      slowEngine.setEncoding("utf8");
      slowEngine.on("data", (chunk: string) => {
        engineBuffer += chunk;
        let boundary: number;
        while ((boundary = engineBuffer.indexOf("\n")) >= 0) {
          recovered = JSON.parse(engineBuffer.slice(0, boundary));
          engineBuffer = engineBuffer.slice(boundary + 1);
        }
      });
      slowEngine.resume();
      await until(
        () => recovered,
        (g) => g?.cells[0].draft === chunk.repeat(8),
      );
      call.finish();
      await until(
        () => latest,
        (g) => g?.status === "complete",
      );
      await until(
        () => recovered,
        (g) => g?.status === "complete",
      );
      assert.equal(f.calls.length, 1);
      assert.equal(call.aborted, false);
      assert.equal(
        readFileSync(
          f.store.files.path(
            f.store.get(grid.id)!.cells[0].artifactId!,
            "index.md",
          )!,
          "utf8",
        ),
        chunk.repeat(8),
      );
      assert.equal(f.store.billing.page(f.owner, 0).costUsd, 0.0123);
    } finally {
      for (const response of slow) response.destroy();
      slowEngine?.destroy();
      await reader?.cancel();
      await reading;
      await f.close();
    }
  },
);

test(
  "repeated disconnects before the initial snapshot release subscription capacity and reconnect to current state",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      const endpoint = `${f.origin}/api/grids/${grid.id}/events`;
      for (let round = 0; round < 12; round++) {
        // Client aborts reach the web process asynchronously. Probe its capacity
        // directly instead of using an unrelated engine request as a barrier.
        await until(
          async () => {
            const controllers = Array.from(
              { length: 4 },
              () => new AbortController(),
            );
            try {
              const responses = await Promise.all(
                controllers.map((controller) =>
                  f.fetch(endpoint, {
                    headers: { cookie: f.cookie },
                    signal: controller.signal,
                  }),
                ),
              );
              for (const response of responses)
                if (response.status !== 429) assert.equal(response.status, 200);
              return responses.every((response) => response.status === 200);
            } finally {
              for (const controller of controllers) controller.abort();
            }
          },
          (available) => available,
        );
      }
      call.write({
        content: "Latest content after reconnect",
        reasoning: "Latest thinking",
      });
      call.finish();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.status === "complete",
      );
      const connected = await f.request(`/api/grids/${grid.id}/events`);
      assert.equal(connected.status, 200);
      const reader = connected.body!.getReader();
      let event = "";
      while (!event.includes("\n\n"))
        event += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      const snapshot = JSON.parse(
        event.slice("data: ".length).split("\n\n")[0],
      );
      assert.equal(snapshot.status, "complete");
      assert.equal(snapshot.cells[0].usage.costUsd, 0.0123);
      assert.equal(
        await (await f.request(snapshot.cells[0].thinkingURL)).text(),
        "Latest thinking",
      );
      assert.equal(
        await (await f.request(`/outputs/${grid.cells[0].id}?raw=1`)).text(),
        "Latest content after reconnect",
      );
      assert.equal(f.calls.length, 1);
      assert.equal(call.aborted, false);
    } finally {
      await f.close();
    }
  },
);
