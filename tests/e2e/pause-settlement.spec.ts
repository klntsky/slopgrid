import { test, expect, type Request } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";
import { holdDatabaseWrites } from "../database-lock";

test.setTimeout(60000);

test("a delayed paused response cannot reopen streaming after the engine restarts", async ({
  page,
}) => {
  const f = await runtimeFixture();
  let unlock = () => {};
  const streams = new Set<Request>();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/events"))
      streams.add(request);
  });
  page.on("requestfailed", (request) => streams.delete(request));
  page.on("requestfinished", (request) => streams.delete(request));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page
      .context()
      .addCookies([{ name: f.cookieName, value: f.owner, url: f.origin }]);
    const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    await f.call(0);
    unlock = holdDatabaseWrites(f.store);
    await f.engine.api.pauseGrid({ gridId: grid.id, sessionId: f.owner });
    await page.goto(`${f.origin}/grid/${grid.id}`);
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(1);
    const endpoint = `${f.origin}/api/grids/${grid.id}`;
    let captured!: () => void;
    const held = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let delivered!: () => void;
    const delivery = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    await page.route(
      endpoint,
      async (route) => {
        const response = await route.fetch();
        expect((await response.json()).live).toBe(true);
        captured();
        await gate;
        await route.fulfill({ response });
        delivered();
      },
      { times: 1 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await held;
    await f.engine.close();
    unlock();
    f.store.setTitle(grid.id, "Recovered engine");
    await f.startEngine();
    // The title proves the replacement snapshot reached the browser cache.
    const title = page.getByRole("button", { name: "Edit title", exact: true });
    await expect(title).toHaveText("Recovered engine");
    await expect.poll(() => streams.size).toBe(0);
    let newStreams = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        new URL(endpoint).pathname + "/events"
      )
        newStreams++;
    });
    release();
    await delivery;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(newStreams).toBe(0);
    await expect(title).toHaveText("Recovered engine");
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    expect(f.calls).toHaveLength(1);
  } finally {
    unlock();
    release();
    try {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    } finally {
      await f.close();
    }
  }
});

test("Pause keeps live updates through reload and reconnect until every cancelled call settles", async ({
  page,
}) => {
  const f = await runtimeFixture({ workers: 2 });
  let unlock = () => {};
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
      .addCookies([{ name: f.cookieName, value: f.owner, url: f.origin }]);
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
    unlock = holdDatabaseWrites(f.store);
    await page.getByRole("button", { name: "Pause generation" }).click();
    // The real SQLite connection waits for its busy timeout before reporting
    // the failed write and returning the paused snapshot.
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("Discarded stream content", { exact: true }),
    ).toHaveCount(0);
    expect(await f.engine.api.status()).toMatchObject({
      activeGrids: 0,
      runningCalls: 2,
    });
    expect((await f.engine.api.getGrid(grid.id)).live).toBe(true);
    await expect.poll(() => streams.size).toBe(1);

    // Reopening a paused grid must discover its outstanding calls from the engine.
    streams.clear();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(1);
    const unavailable = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/events") &&
        response.status() === 502,
    );
    await kill(f.web);
    await unavailable;
    await expect.poll(() => streams.size).toBe(0);

    // Real HTTP cancellation closes both provider sockets; pending persistence
    // keeps the grid live until the external database lock is released.
    await expect.poll(() => first.aborted && second.aborted).toBe(true);
    first.write({
      content: "Late cancelled output",
      reasoning: "Late thinking",
    });
    await f.startWeb();
    await expect.poll(() => streams.size, { timeout: 15000 }).toBe(1);
    expect(await f.engine.api.status()).toMatchObject({ runningCalls: 2 });
    expect((await f.engine.api.getGrid(grid.id)).live).toBe(true);
    second.write({ content: "Another discarded output" });
    unlock();
    await expect.poll(() => streams.size).toBe(0);
    const settled = await f.engine.api.getGrid(grid.id);
    expect(settled.live).toBe(false);
    expect(settled).toMatchObject({ status: "paused", spentUsd: 0 });
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
      costUsd: 0,
      running: 0,
      total: 2,
    });
  } finally {
    unlock();
    await page.close();
    await f.close();
  }
});
