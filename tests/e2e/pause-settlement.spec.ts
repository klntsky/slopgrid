import { test, expect, type Request } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";

test("Pause keeps live updates through reload and reconnect until every cancelled call settles", async ({
  page,
}) => {
  const f = await runtimeFixture({ workers: 2, ignoreAbort: true });
  const streams = new Set<Request>();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/events"))
      streams.add(request);
  });
  page.on("requestfailed", (request) => streams.delete(request));
  page.on("requestfinished", (request) => streams.delete(request));
  try {
    await page
      .context()
      .addCookies([{ name: "slopgrid", value: f.owner, url: f.origin }]);
    const grid = f.grid({ parallelWorkers: 2 });
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const first = await f.call(0);
    const second = await f.call(1);
    first.write({
      content: "Discarded stream content",
      reasoning: "Saved thinking",
    });
    await page.goto(`${f.origin}/grid/${grid.id}`);
    await expect(
      page.getByText("Discarded stream content", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(1);
    await page.getByRole("button", { name: "Pause generation" }).click();
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    await expect(
      page.getByText("Discarded stream content", { exact: true }),
    ).toHaveCount(0);
    expect(await f.engine.api.status()).toMatchObject({
      activeGrids: 0,
      runningCalls: 2,
    });
    await expect.poll(() => streams.size).toBe(1);

    // Reopening a paused grid must discover its outstanding calls from the engine.
    streams.clear();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(1);
    await kill(f.web);
    await expect.poll(() => streams.size).toBe(0);

    // Settlement during disconnection must appear in the reconnect snapshot.
    first.write({
      content: "Late cancelled output",
      reasoning: "Late thinking",
    });
    first.finish(0.25);
    await f.startWeb();
    await expect.poll(() => streams.size).toBe(1);
    await expect(
      page.getByLabel("Total spent: $0.25", { exact: true }),
    ).toBeVisible();
    expect(streams.size).toBe(1);
    expect(await f.engine.api.status()).toMatchObject({ runningCalls: 1 });
    second.write({ content: "Another discarded output" });
    second.finish(0.5);
    await expect(
      page.getByLabel("Total spent: $0.75", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(0);
    const settled = await f.engine.api.getGrid(grid.id);
    expect(settled).toMatchObject({ status: "paused", spentUsd: 0.75 });
    expect(settled.cells.map((cell) => cell.status)).toEqual([
      "pending",
      "pending",
    ]);
    await expect(
      page.getByText("Late cancelled output", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Another discarded output", { exact: true }),
    ).toHaveCount(0);
    expect((await f.request(`/outputs/${grid.cells[0].id}`)).status).toBe(404);
    expect(f.store.billing.page(f.owner, 0)).toMatchObject({
      costUsd: 0.75,
      running: 0,
      total: 2,
    });
  } finally {
    await page.close();
    await f.close();
  }
});
