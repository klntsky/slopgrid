import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { serveGeneration } from "../../server/generation-server";
import type { GenerationSnapshot } from "../../server/generation-api";
import { runtimeFixture } from "../runtime-fixture";

for (const size of [1024, 1024 * 1024]) {
  test(`a browser receives ${size}-byte snapshot bursts without reopening events`, async ({
    page,
    context,
  }, testInfo) => {
    const f = await runtimeFixture();
    const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
    const initial = await f.engine.api.getGrid(grid.id);
    let current: GenerationSnapshot = {
      ...initial,
      status: "running",
      live: true,
      cells: initial.cells.map((cell) => ({
        ...cell,
        status: "running",
        draft: "Ready",
      })),
    };
    let publish: ((grid: GenerationSnapshot) => void) | undefined;
    const socket = join(f.directory, "browser-burst.sock");
    // Control notification timing without intercepting browser requests or
    // replacing EventSource, the engine transport, or the web streaming route.
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
    const requests: { atMs: number; status?: number }[] = [];
    const started = Date.now();
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/events")) {
        const entry: (typeof requests)[number] = { atMs: Date.now() - started };
        requests.push(entry);
        void request.response().then((response) => {
          entry.status = response?.status();
        });
      }
    });
    try {
      await f.startWeb(socket);
      await context.addCookies([
        {
          name: "__Host-slopgrid",
          value: f.owner,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          url: f.origin,
        },
      ]);
      await page.goto(`${f.origin}/grid/${grid.id}`);
      const preview = page.locator(".markdown-preview:visible");
      await expect(preview).toContainText("Ready");
      await expect.poll(() => publish !== undefined).toBe(true);
      expect(requests).toHaveLength(1);
      // A Markdown comment keeps the rendered DOM small while the transport
      // still carries the complete draft on each engine notification.
      const prefix = `<!--${"x".repeat(size)}-->\n\n`;
      for (let round = 1; round <= 3; round++) {
        await expect.poll(() => publish !== undefined).toBe(true);
        for (let update = 1; update <= 2; update++) {
          current = {
            ...current,
            version: {
              ...current.version,
              sequence: current.version.sequence + 1,
            },
            cells: current.cells.map((cell) => ({
              ...cell,
              draft: `${prefix}Round ${round}, update ${update}`,
            })),
          };
          publish!(current);
        }
        // Recovery may use another connection. Check it recovers the actual
        // latest output before asserting that no reconnect was necessary.
        await expect(preview).toContainText(`Round ${round}, update 2`, {
          timeout: 10000,
        });
      }
      expect(f.calls).toHaveLength(0);
      expect(
        requests,
        "snapshot bursts must reach the browser on its original SSE connection",
      ).toHaveLength(1);
    } finally {
      console.log(
        `SSE requests for ${size}-byte drafts: ${JSON.stringify(requests)}`,
      );
      await testInfo.attach("events-requests", {
        body: JSON.stringify(requests, null, 2),
        contentType: "application/json",
      });
      await page.close();
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
