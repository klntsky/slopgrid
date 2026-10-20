import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "../generation-fixture";
import { webFixture } from "../web-fixture";
import { Store } from "../../server/store";
import { expandGrid, type GridInput, type Grid } from "../../server/domain";
import { token } from "../../server/ids";
import { createWorkflow } from "../../server/workflow";
import { startTestServer } from "../test-server";
import { create, expectProgress } from "./helpers";
import { parseE2EPort } from "../e2e-port";

const port = parseE2EPort(process.env.E2E_PORT);

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
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const chatImages = ["first.png", "later.png"].map((name) =>
      store.references.add(Buffer.concat([bytes, Buffer.from(name)]), name, {
        id: owner,
        created: Date.now(),
      })!,
    );
    const unusedImage = store.references.add(bytes, "unused.png", {
      id: owner,
      created: Date.now(),
    })!;
    const grids = (
      ["markdown", "svg", "image", "html", "chat-template"] as const
    ).map((format) => {
      const input: GridInput = {
        format,
        prompt: `Offline ${format}`,
        ...(format === "chat-template"
          ? {
              messages: [
                {
                  role: "user" as const,
                  content: "First image",
                  images: [chatImages[0]],
                },
                { role: "unfilled" as const, content: "" },
                {
                  role: "user" as const,
                  content: "Later image",
                  images: [chatImages[1]],
                },
                { role: "unfilled" as const, content: "" },
              ],
            }
          : {}),
        rows: { kind: "model", values: ["fixture/text"] },
        columns: { kind: "variable", values: [[{ text: "one" }]] },
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
        })),
      };
      const tasks = createWorkflow(input, grid.cells);
      const task = tasks.find((task) => task.kind === "generation")!;
      task.status = "complete";
      task.output = {
        artifactId: token(),
        mediaType: format === "image" ? "image/png" : undefined,
        provenance: {
          signature: "offline-output",
          files:
            format === "chat-template"
              ? ["messages.json"]
              : format === "markdown"
                ? ["index.md"]
                : format === "svg"
                  ? ["index.svg"]
                  : format === "image"
                    ? ["image"]
                    : [
                        "index.html",
                        "style.css",
                        "theme.css",
                        "app.js",
                        "message.js",
                        "nested/page.html",
                      ],
        },
        thinkingId: token(),
        thinkingSourceId: token(),
      };
      store.insert(grid, tasks);
      store.files.appendThinking(
        task.output.thinkingSourceId!,
        task.output.thinkingId!,
        `Saved ${format} thinking`,
      );
      store.files.write(
        task.output.artifactId,
        format === "chat-template"
          ? {
              "messages.json": JSON.stringify([
                { role: "user", content: "First image" },
                { role: "assistant", content: "First answer" },
                { role: "user", content: "Later image" },
                { role: "assistant", content: "Later answer" },
              ]),
            }
          : format === "markdown"
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
    });
    // Finished generation must remain cacheable while judging is pending or fails.
    // Overall cell status includes judging, so it cannot determine output readiness.
    for (const status of ["pending", "error", "complete"] as const) {
      const template = grids[0];
      const cellId = token();
      const filename = "index.md";
      const grid: Grid = {
        ...template,
        id: token(),
        input: {
          ...template.input,
          prompt: `Offline judgment ${status}`,
          judge: {
            criteria: [{ text: "Is this a website?", correctAnswer: false }],
            model: "fixture/text",
            effort: "default",
          },
        },
        status: "paused",
        cells: [
          {
            ...template.cells[0],
            id: cellId,
            status,
            judge: {
              model: "fixture/text",
              effort: "default",
              status,
              ...(status === "error" ? { error: "Judge unavailable" } : {}),
              ...(status === "complete"
                ? {
                    results: [
                      {
                        verdict: false,
                        explanation: "This is saved Markdown, not a website.",
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
      };
      const tasks = createWorkflow(grid.input, grid.cells);
      const task = tasks.find((task) => task.kind === "generation")!;
      const judgment = tasks.find((task) => task.kind === "judge")!;
      task.status = "complete";
      task.output = {
        artifactId: token(),
        provenance: { signature: "offline-output", files: [filename] },
        thinkingId: token(),
        thinkingSourceId: token(),
      };
      judgment.status = status;
      if (status === "error") judgment.error = "Judge unavailable";
      if (status === "complete")
        judgment.output = { results: grid.cells[0].judge!.results! };
      store.insert(grid, tasks);
      store.files.appendThinking(
        task.output.thinkingSourceId!,
        task.output.thinkingId!,
        `Saved judgment ${status} thinking`,
      );
      store.files.write(task.output.artifactId, {
        [filename]: "# Cached markdown\n\nSaved content",
      });
      grids.push(grid);
    }
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
    for (const image of chatImages) {
      await expect
        .poll(() =>
          page.evaluate(async (id) => {
            for (const name of await caches.keys()) {
              if (
                await (await caches.open(name)).match(`/api/references/${id}`)
              )
                return true;
            }
            return false;
          }, image.id),
        )
        .toBe(true);
    }
    expect(
      await page.evaluate(async (id) => {
        for (const name of await caches.keys()) {
          if (await (await caches.open(name)).match(`/api/references/${id}`))
            return true;
        }
        return false;
      }, unusedImage.id),
    ).toBe(false);
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        referenceTrace?: { url: string; status: number }[];
        originalReferenceFetch?: typeof fetch;
      };
      state.referenceTrace = [];
      state.originalReferenceFetch = fetch;
      state.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await state.originalReferenceFetch!(...args);
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (url.includes("cache-probe=conditional"))
          state.referenceTrace!.push({ url, status: response.status });
        return response;
      };
    });
    const probe = `/api/references/${chatImages[0].id}?cache-probe=conditional`;
    try {
      const reused = await page.evaluate(async (url) => {
        const first = await fetch(url, { mode: "no-cors", cache: "reload" });
        const firstBytes = Array.from(
          new Uint8Array(await first.arrayBuffer()),
        );
        const second = await fetch(url, { mode: "no-cors", cache: "reload" });
        return {
          firstBytes,
          secondBytes: Array.from(new Uint8Array(await second.arrayBuffer())),
        };
      }, probe);
      expect(Buffer.from(reused.firstBytes)).toEqual(
        Buffer.concat([bytes, Buffer.from(chatImages[0].name)]),
      );
      expect(reused.secondBytes).toEqual(reused.firstBytes);
      const statuses = await worker.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            referenceTrace: { url: string; status: number }[];
          }
        ).referenceTrace.map(({ status }) => status),
      );
      expect(statuses).toEqual([200, 304]);
    } finally {
      await worker.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          referenceTrace?: { url: string; status: number }[];
          originalReferenceFetch?: typeof fetch;
        };
        state.fetch = state.originalReferenceFetch!;
        delete state.originalReferenceFetch;
        delete state.referenceTrace;
      });
    }
    for (const grid of grids.filter((grid) => grid.input.judge)) {
      const savedCell = await page.evaluate(async (id) => {
        for (const name of await caches.keys()) {
          const response = await (
            await caches.open(name)
          ).match(`/api/grids/${id}`);
          if (response) return (await response.json()).cells[0];
        }
      }, grid.id);
      expect(savedCell.outputReady).toBe(true);
      expect(savedCell.outputURL).toContain(`/outputs/${grid.cells[0].id}`);
      expect(savedCell.judge).toEqual(grid.cells[0].judge);
    }
    await page.goto(web.origin);
    await context.setOffline(true);
    await page.reload();
    for (const grid of grids) {
      await page
        .getByRole("link", {
          name: new RegExp(`${grid.input.prompt}$`),
        })
        .click();
      if (grid.cells[0].judge?.status === "complete") {
        const judgment = page.getByRole("region", {
          name: "Judgment details",
          exact: true,
        });
        await expect(
          judgment.getByRole("img", { name: "Correct", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: "Judgment: 1 of 1 correct",
            exact: true,
          })
          .click();
      }
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
      if (grid.input.format === "chat-template") {
        await expect(
          page.getByText("Later answer", { exact: true }),
        ).toBeVisible();
        for (const image of chatImages)
          await expect
            .poll(() =>
              page
                .getByRole("img", { name: image.name, exact: true })
                .evaluate(
                  (element) => (element as HTMLImageElement).naturalWidth,
                ),
            )
            .toBe(1);
      }
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
      if (grid.input.format === "chat-template") {
        for (const image of chatImages)
          await expect
            .poll(() =>
              page
                .getByRole("img", { name: image.name, exact: true })
                .evaluate(
                  (element) => (element as HTMLImageElement).naturalWidth,
                ),
            )
            .toBe(1);
      }
      if (grid.input.judge) {
        const snapshot = await page.evaluate(
          async (id) => (await fetch(`/api/grids/${id}`)).json(),
          grid.id,
        );
        expect(snapshot.live).toBe(false);
        expect(snapshot.cells[0].outputReady).toBe(true);
        expect(snapshot.cells[0].judge).toEqual(grid.cells[0].judge);
      }
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
    for (const image of chatImages)
      expect(
        await page.evaluate(
          async (id) => (await fetch(`/api/references/${id}`)).status,
          image.id,
        ),
      ).toBe(503);
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
  const server = await startTestServer("mock", port);
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
        page
          .getByRole("img", { name: "SVG preview", exact: true })
          .getAttribute("src"),
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
