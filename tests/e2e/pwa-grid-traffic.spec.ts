import { test, expect, type Page } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";
import type { ViewGrid } from "../../src/api";
import { single, verdicts } from "../judging-runtime-fixture";

async function cachedGrid(
  page: Page,
  id: string,
): Promise<ViewGrid | undefined> {
  return page.evaluate(async (id) => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("slopgrid-data-")) continue;
      const response = await (
        await caches.open(name)
      ).match(`/api/grids/${id}`);
      if (response) return response.json();
    }
  }, id);
}

for (const exists of [true, false]) {
  test(`an uncached offline ${exists ? "grid restores" : "missing grid fails once"} when connectivity returns`, async ({
    playwright,
  }) => {
    let reads = 0;
    let gridPath = "";
    const fixture = await runtimeFixture({
      observeRequest(request) {
        if (request.method === "GET" && request.url === gridPath) reads++;
      },
    });
    const browser = await playwright.chromium.launch({
      args: ["--ignore-certificate-errors"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          name: fixture.cookieName,
          value: fixture.owner,
          url: fixture.origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const grid = fixture.grid();
      const id = exists ? grid.id : "0".repeat(48);
      gridPath = `/api/grids/${id}`;
      const page = await context.newPage();
      await page.goto(fixture.origin);
      await expect
        .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
        .toBe(true);
      expect(await cachedGrid(page, id)).toBeUndefined();
      await page.clock.install();
      await context.setOffline(true);
      await page.goto(`${fixture.origin}/grid/${id}`);
      await expect(page.getByRole("alert")).toContainText(
        "This page isn't available offline.",
      );
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await page.clock.pauseAt(
        new Date(await page.evaluate(() => Date.now() + 1000)),
      );
      const offlineReads = reads;
      await page.clock.runFor(120000);
      expect(reads).toBe(offlineReads);
      const restored = page.waitForEvent("requestfinished", {
        predicate: (request) =>
          request.method() === "GET" &&
          new URL(request.url()).pathname === gridPath,
      });
      await context.setOffline(false);
      await page.clock.runFor(1001);
      await restored;
      await page.evaluate(() => undefined);
      await page.clock.runFor(1);
      if (exists) {
        await expect(
          page.getByRole("button", { name: "Resume generation" }),
        ).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(reads - offlineReads).toBe(1);
        await page.clock.resume();
        await page.getByRole("button", { name: "Resume generation" }).click();
        const call = await fixture.nextCall();
        call.write({
          content: "Live output after offline cache-miss recovery.",
        });
        await expect(
          page.locator(".markdown-preview:visible").first(),
        ).toContainText("Live output after offline cache-miss recovery.");
        await expect(page.locator(".connection-status")).toHaveCount(0);
      } else {
        await expect(page.getByRole("alert")).toContainText("Grid not found");
        expect(reads - offlineReads).toBe(1);
        await page.evaluate(() =>
          document.dispatchEvent(
            new Event("visibilitychange", { bubbles: true }),
          ),
        );
        await page.clock.runFor(120000);
        expect(reads - offlineReads).toBe(1);
      }
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

for (const scenario of [
  "online restoration",
  "unchanged completion",
] as const) {
  test(`PWA ${scenario} does not redownload an already covered grid`, async ({
    playwright,
  }) => {
    test.setTimeout(60000);
    const gridReads: string[] = [];
    const fixture = await runtimeFixture({
      observeRequest(request) {
        if (
          request.method === "GET" &&
          /^\/api\/grids\/[a-f0-9]{48}$/.test(request.url ?? "")
        )
          gridReads.push(request.url!);
      },
    });
    const browser = await playwright.chromium.launch({
      args: ["--ignore-certificate-errors"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          name: fixture.cookieName,
          value: fixture.owner,
          url: fixture.origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const grid = fixture.grid({ rows: [{ variable: [{ text: "cat" }] }] });
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/grid/${grid.id}`);
      await expect
        .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
        .toBe(true);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const call = await fixture.nextCall();
      call.write({
        content: "# Completed over SSE\n\nOffline completion bytes.",
      });
      await expect(page.locator(".markdown-preview:visible")).toContainText(
        "Completed over SSE",
      );
      // Only an authorized HTTP snapshot may populate the worker's grid cache.
      await page.evaluate(async (id) => {
        await fetch(`/api/grids/${id}`);
      }, grid.id);
      await expect
        .poll(async () => (await cachedGrid(page, grid.id))?.cells[0].status)
        .toBe("running");
      const completionReads = gridReads.length;
      call.finish();
      await expect
        .poll(async () => (await cachedGrid(page, grid.id))?.cells[0].status)
        .toBe("complete");
      await expect
        .poll(() =>
          page.evaluate(async (id) => {
            for (const name of await caches.keys()) {
              if (!name.startsWith("slopgrid-data-")) continue;
              if (
                await (await caches.open(name)).match(`/outputs/${id}/download`)
              )
                return true;
            }
            return false;
          }, grid.cells[0].id),
        )
        .toBe(true);
      expect(gridReads.length - completionReads).toBe(1);
      const completed = await cachedGrid(page, grid.id);
      expect(completed?.cells[0].draft).toBeUndefined();
      expect(completed?.cells[0].thinking).toBeUndefined();

      if (scenario === "online restoration") {
        await context.setOffline(true);
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Completed over SSE" }),
        ).toBeVisible();
        const before = gridReads.length;
        const restored = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/grids/${grid.id}` &&
            response.status() === 200,
        );
        await context.setOffline(false);
        await restored;
        await expect(page.locator(".connection-status")).toHaveCount(0);
        // Observe the real proxy, including requests initiated by the worker.
        await page.waitForTimeout(1000);
        expect(gridReads.length - before).toBe(1);
      } else {
        const before = gridReads.length;
        await page.evaluate(async (grid) => {
          if (!grid) throw new Error("Completed server snapshot missing");
          for (const name of await caches.keys()) {
            if (!name.startsWith("slopgrid-data-")) continue;
            await (
              await caches.open(name)
            ).delete(`/outputs/${grid.cells[0].id}/download`);
          }
          navigator.serviceWorker.controller!.postMessage({
            type: "cache-grid",
            id: grid.id,
            completed: grid.cells
              .filter((cell) => cell.outputReady || cell.status === "complete")
              .map((cell) => ({
                id: cell.id,
                generationId: cell.generationId,
              })),
          });
        }, completed);
        // Rewarming a removed output proves the notification was processed.
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              for (const name of await caches.keys()) {
                if (!name.startsWith("slopgrid-data-")) continue;
                if (
                  await (
                    await caches.open(name)
                  ).match(`/outputs/${id}/download`)
                )
                  return true;
              }
              return false;
            }, grid.cells[0].id),
          )
          .toBe(true);
        expect(gridReads.length - before).toBe(0);
      }
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

test("a delayed judgment refreshes the offline snapshot without redownloading completed output", async ({
  playwright,
}) => {
  test.setTimeout(60000);
  const outputReads: string[] = [];
  const fixture = await runtimeFixture({
    judges: true,
    observeRequest(request) {
      if (request.method === "GET" && request.url?.startsWith("/outputs/"))
        outputReads.push(request.url);
    },
  });
  const browser = await playwright.chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        value: fixture.owner,
        url: fixture.origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const grid = fixture.grid(single);
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await page.getByRole("button", { name: "Resume generation" }).click();
    const generation = await fixture.nextCall();
    generation.write({ content: "# Cached before judgment" });
    generation.finish();
    const judge = await fixture.nextCall();
    await expect
      .poll(async () => (await cachedGrid(page, grid.id))?.cells[0].outputReady)
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          for (const name of await caches.keys()) {
            if (!name.startsWith("slopgrid-data-")) continue;
            if (
              await (await caches.open(name)).match(`/outputs/${id}/download`)
            )
              return true;
          }
          return false;
        }, grid.cells[0].id),
      )
      .toBe(true);
    expect((await cachedGrid(page, grid.id))?.cells[0].judge?.status).not.toBe(
      "complete",
    );
    const beforeJudgment = outputReads.length;
    judge.write({ content: JSON.stringify(verdicts) });
    judge.finish();
    await expect(
      page.getByRole("button", {
        name: "Judgment: 1 of 2 correct",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(
        async () => (await cachedGrid(page, grid.id))?.cells[0].judge?.results,
      )
      .toEqual(verdicts.results);
    expect(outputReads.length - beforeJudgment).toBe(0);
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByText("No blue circle.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No rectangle in this text.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Cached before judgment" }),
    ).toBeVisible();
  } finally {
    await browser.close();
    await fixture.close();
  }
});
