import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "../generation-fixture";
import { webFixture } from "../web-fixture";
import { Store } from "../../server/store";
import { expandGrid, type GridInput, type Grid } from "../../server/domain";
import { token } from "../../server/ids";
import { startTestServer } from "../test-server";
import { create, expectProgress } from "./helpers";

test("visited pages and completed outputs survive offline reload without retaining streaming output or another session", async ({
  playwright,
}) => {
  test.setTimeout(90000);
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-pwa-"));
  const database = join(directory, "db.sqlite");
  const secret = Buffer.alloc(32, 7);
  const generation = await startGenerationFixture({ database, secret });
  const store = new Store(database, secret);
  const web = await webFixture({
    directory,
    database,
    secret,
    socket: database + ".sock",
    hostname: "slopgrid.test",
  });
  const browser = await playwright.chromium.launch({
    args: [
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  try {
    const owner = token();
    store.saveSession({ id: owner, created: Date.now() });
    const grids = (["markdown", "svg", "image", "html"] as const).map(
      (format) => {
        const input: GridInput = {
          format,
          prompt: `Offline ${format}`,
          rows: { kind: "model", values: ["fixture/text"] },
          columns: { kind: "variable", values: ["one"] },
          model: "fixture/text",
          effort: "none",
          budgetUsd: 1,
        };
        const grid: Grid = {
          id: token(),
          owner,
          input,
          status: "complete",
          published: false,
          visibility: "private",
          createdAt: new Date().toISOString(),
          cells: expandGrid(input).map((cell) => ({
            ...cell,
            id: token(),
            status: "complete",
            ...(format === "image" ? { mediaType: "image/png" } : {}),
          })),
        };
        store.insert(grid);
        store.files.write(
          grid.cells[0].id,
          format === "markdown"
            ? { "index.md": "# Cached markdown\n\nSaved content" }
            : format === "svg"
              ? {
                  "index.svg":
                    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
                }
              : format === "image"
                ? {
                    image: Buffer.from(
                      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                      "base64",
                    ),
                  }
                : {
                    "index.html":
                      '<link rel="stylesheet" href="/style.css"><h1>Cached website</h1><p>Loading</p><script type="module" src="app.js"></script><a href="nested/page.html">Next page</a>',
                    "style.css":
                      '@import "./theme.css"; h1 { color: rgb(0, 0, 128); }',
                    "theme.css": "body { background: rgb(255, 255, 240); }",
                    "app.js":
                      'import { message } from "./message.js"; document.querySelector("p").textContent = message;',
                    "message.js":
                      'export const message = "Cached module loaded";',
                    "nested/page.html":
                      '<h1>Nested cached page</h1><a href="../index.html">Back</a>',
                  },
        );
        return grid;
      },
    );
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: owner,
        url: web.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.goto(web.origin);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    for (const grid of grids) {
      await page.goto(`${web.origin}/grid/${grid.id}`);
      await expect(page.locator("article.cell")).toHaveCount(1);
      // Completion is observable through CacheStorage rather than a timing delay.
      await expect
        .poll(() =>
          page.evaluate(async (id) => {
            for (const name of await caches.keys()) {
              const cache = await caches.open(name);
              if (await cache.match(`/outputs/${id}/download`)) return true;
            }
            return false;
          }, grid.cells[0].id),
        )
        .toBe(true);
    }
    await page.goto(web.origin);
    await context.setOffline(true);
    await page.reload();
    for (const grid of grids) {
      await page
        .getByRole("link", {
          name: new RegExp(`Offline ${grid.input.format}$`),
        })
        .click();
      if (grid.input.format === "markdown")
        await expect(
          page.getByRole("heading", { name: "Cached markdown" }),
        ).toBeVisible();
      if (grid.input.format === "svg")
        await expect
          .poll(() =>
            page
              .getByRole("img", { name: "Generated SVG" })
              .evaluate((el) => (el as HTMLImageElement).naturalWidth),
          )
          .toBe(40);
      if (grid.input.format === "image")
        await expect
          .poll(() =>
            page
              .getByRole("img", { name: "Generated image" })
              .evaluate((el) => (el as HTMLImageElement).naturalWidth),
          )
          .toBe(1);
      if (grid.input.format === "html") {
        const frame = page.frameLocator('iframe[aria-hidden="false"]');
        await expect(frame.getByText("Cached module loaded")).toBeVisible();
        await expect(frame.locator("h1")).toHaveCSS("color", "rgb(0, 0, 128)");
        await expect(frame.locator("body")).toHaveCSS(
          "background-color",
          "rgb(255, 255, 240)",
        );
        expect(
          await frame.locator("body").evaluate(async () => {
            document
              .querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
              .forEach((node) => node.remove());
            try {
              await fetch("/api/session");
              return true;
            } catch {
              return false;
            }
          }),
        ).toBe(false);
        await frame.getByRole("link", { name: "Next page" }).click();
        await expect(
          frame.getByRole("heading", { name: "Nested cached page" }),
        ).toBeVisible();
      }
      await page.reload();
      await expect(page.locator("article.cell")).toHaveCount(1);
      await page.goto(web.origin);
    }
    await page.goto(`${web.origin}/grid/${token()}`);
    await expect(
      page.getByText("This page isn't available offline.", { exact: true }),
    ).toBeVisible();
    await context.setOffline(false);
    await page.goto(web.origin);
    await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
    await context.clearCookies();
    await page.goto(web.origin);
    await context.setOffline(true);
    await page.goto(`${web.origin}/grid/${grids[0].id}`);
    await expect(page.getByText("Saved content")).toHaveCount(0);
  } finally {
    await browser.close();
    await web.close();
    await generation.close();
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming output is excluded until completion and remains available after reconnecting", async ({
  playwright,
}) => {
  const server = await startTestServer("mock");
  const browser = await playwright.chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  try {
    const context = await browser.newContext({
      baseURL: server.origin,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.request.post("/fixture/reset", { data: { svgStreaming: true } });
    await create(page, "SVG", "cat", "hat");
    await expect(
      page.getByRole("img", { name: "SVG preview", exact: true }),
    ).toBeVisible();
    const gridURL = page.url();
    const id = new URL(gridURL).pathname.split("/").pop()!;
    const snapshot = await page.evaluate(
      async (id) => (await fetch(`/api/grids/${id}`)).json(),
      id,
    );
    const cellId = snapshot.cells[0].id;
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          for (const name of await caches.keys()) {
            if (!name.startsWith("slopgrid-data-")) continue;
            const cache = await caches.open(name);
            const response = await cache.match(`/api/grids/${id}`);
            if (response) return (await response.json()).cells[0];
          }
        }, id),
      )
      .toMatchObject({ status: "running" });
    const cachedCell = await page.evaluate(async (id) => {
      for (const name of await caches.keys()) {
        const response = await (
          await caches.open(name)
        ).match(`/api/grids/${id}`);
        if (response) return (await response.json()).cells[0];
      }
    }, id);
    for (const field of [
      "draft",
      "thinking",
      "previewURL",
      "outputURL",
      "thinkingURL",
    ])
      expect(cachedCell[field]).toBeUndefined();
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByText("This output isn't available offline.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".generated-image")).toHaveCount(0);
    await context.setOffline(false);
    await page.request.post("/fixture/svg-next");
    await expect
      .poll(() =>
        page.getByRole("img", { name: "SVG preview", exact: true }).getAttribute("src"),
      )
      .toContain("fill%3D%22blue");
    await page.request.post("/fixture/svg-next");
    await expectProgress(page, 1, 1);
    await expect
      .poll(() =>
        page.evaluate(async (cellId) => {
          for (const name of await caches.keys())
            if (
              await (
                await caches.open(name)
              ).match(`/outputs/${cellId}/download`)
            )
              return true;
          return false;
        }, cellId),
      )
      .toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Generated SVG" })
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
  } finally {
    await browser.close();
    await server.close();
  }
});
