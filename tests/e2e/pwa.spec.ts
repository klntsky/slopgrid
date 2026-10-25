import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGenerationFixture } from "../generation-fixture";
import { webFixture } from "../web-fixture";
import { Store } from "../../server/store";
import { expandGrid, type Grid, type ChatMessage } from "../../server/domain";
import { token } from "../../server/ids";
import { createWorkflow } from "../../server/workflow";
import { cacheScope } from "../../server/session";
import { startTestServer } from "../test-server";
import { create, expectProgress } from "./helpers";
import { parseE2EPort } from "../e2e-port";
import { currentInput } from "../current-grid-fixture";
import { pixelPng as bytes } from "../reference-image-fixture";

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
    const chatMessages: ChatMessage[] = [
      { role: "user", content: "First image", images: [chatImages[0]] },
      { role: "unfilled", content: "" },
      { role: "user", content: "Later image", images: [chatImages[1]] },
      { role: "unfilled", content: "" },
    ];
    const chatOutput = JSON.stringify([
      {
        role: "user",
        content: "First image",
        images: [
          {
            name: chatImages[0].name,
            mediaType: "image/png",
            width: 1,
            height: 1,
            dataUrl: `data:image/png;base64,${Buffer.concat([bytes, Buffer.from(chatImages[0].name)]).toString("base64")}`,
          },
        ],
      },
      { role: "assistant", content: "First answer" },
      {
        role: "user",
        content: "Later image",
        images: [
          {
            name: chatImages[1].name,
            mediaType: "image/png",
            width: 1,
            height: 1,
            dataUrl: `data:image/png;base64,${Buffer.concat([bytes, Buffer.from(chatImages[1].name)]).toString("base64")}`,
          },
        ],
      },
      { role: "assistant", content: "Later answer" },
    ]);
    function completedGrid(
      input: ReturnType<typeof currentInput>,
      files: Record<string, string | Buffer>,
      thinking: string,
      judgeStatus?: "pending" | "error" | "complete",
      published = false,
    ): Grid {
      const grid = {
        id: token(),
        owner,
        input,
        status: judgeStatus ? "paused" : "complete",
        published,
        visibility: published ? "unlisted" : "private",
        createdAt: new Date().toISOString(),
        cells: expandGrid(input).map((cell) => ({ ...cell, id: token() })),
      } satisfies Grid;
      const tasks = createWorkflow(input, grid.cells);
      const generation = tasks.find((task) => task.kind === "generation")!;
      generation.status = "complete";
      generation.output = {
        artifactId: token(),
        mediaType: input.format === "image" ? "image/png" : undefined,
        provenance: { signature: "offline-output", files: Object.keys(files) },
        thinkingId: token(),
        thinkingSourceId: token(),
      };
      const judgment = tasks.find((task) => task.kind === "judge");
      if (judgment && judgeStatus) {
        judgment.status = judgeStatus;
        if (judgeStatus === "error") judgment.error = "Judge unavailable";
        if (judgeStatus === "complete")
          judgment.output = {
            results: [
              {
                verdict: false,
                explanation: "This is saved Markdown, not a website.",
              },
            ],
          };
      }
      store.insert(grid, tasks);
      store.files.appendThinking(
        generation.output.thinkingSourceId!,
        generation.output.thinkingId!,
        thinking,
      );
      store.files.write(generation.output.artifactId, files);
      return grid;
    }
    const grids: Grid[] = (
      ["markdown", "svg", "image", "html", "chat-template"] as const
    ).map((format) => {
      const input = currentInput({
        format,
        parameters: {
          input: {
            kind: "common",
            value:
              format === "chat-template"
                ? chatMessages
                : [{ role: "user", content: `Offline ${format}` }],
          },
          model: { kind: "rows" },
          ...(format === "image"
            ? { quality: { kind: "columns" as const } }
            : { effort: { kind: "columns" as const } }),
        },
        rows: [
          { model: format === "image" ? "fixture/image" : "fixture/text" },
        ],
        columns:
          format === "image" ? [{ quality: "auto" }] : [{ effort: "none" }],
        budgetUsd: 1,
      });
      const grid = completedGrid(
        input,
        format === "chat-template"
          ? {
              "messages.json": chatOutput,
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
                    image: bytes,
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
        `Saved ${format} thinking`,
      );
      return grid;
    });
    // Finished generation must remain cacheable while judging is pending or fails.
    // Overall cell status includes judging, so it cannot determine output readiness.
    for (const [format, status] of [
      ["markdown", "pending"],
      ["markdown", "error"],
      ["markdown", "complete"],
      ["chat-template", "pending"],
    ] as const) {
      const filename =
        format === "chat-template" ? "messages.json" : "index.md";
      const input = currentInput({
        format,
        judge: true,
        parameters: {
          input: {
            kind: "common",
            value:
              format === "chat-template"
                ? chatMessages
                : [{ role: "user", content: `Offline judgment ${status}` }],
          },
          model: { kind: "rows" },
          effort: { kind: "columns" },
          judge_criteria: {
            kind: "common",
            value: [{ text: "Is this a website?", correctAnswer: false }],
          },
        },
        rows: [{ model: "fixture/text" }],
        columns: [{ effort: "none" }],
        budgetUsd: 1,
      });
      grids.push(
        completedGrid(
          input,
          {
            [filename]:
              format === "chat-template"
                ? chatOutput
                : "# Cached markdown\n\nSaved content",
          },
          `Saved judgment ${status} thinking`,
          status,
        ),
      );
    }
    for (const published of [false, true]) {
      const input = currentInput({
        caseAxes: ["rows", "columns"],
        parameters: {
          input: {
            kind: "common",
            value: [
              {
                role: "user",
                content: "Offline canonical $ROW1 wearing a $COLUMN1",
              },
            ],
          },
        },
        rows: [{ variable: [{ text: "cat" }] }],
        columns: [{ variable: [{ text: "hat" }] }],
      });
      grids.push(
        completedGrid(
          input,
          { "index.md": "# Cached markdown\n\nSaved content" },
          "Saved canonical thinking",
          undefined,
          published,
        ),
      );
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
      const configure = page.getByRole("button", {
        name: grid.published ? "FORK" : "EDIT",
        exact: true,
      });
      await expect(configure).toBeEnabled();
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
      expect(
        await page.evaluate(
          async (id) => (await fetch(`/api/references/${id}`)).ok,
          image.id,
        ),
      ).toBe(true);
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
      await page.locator(`a[href="/grid/${grid.id}"]`).click();
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
      const configure = page.getByRole("button", {
        name: grid.published ? "FORK" : "EDIT",
        exact: true,
      });
      await expect(configure).toBeEnabled();
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
    // Switch while offline: reconnect refetches /api/session, whose renewal
    // could otherwise overwrite the replacement cookie with the original owner.
    const otherSession = { id: token(), created: Date.now() };
    store.saveSession(otherSession);
    for (const image of chatImages) {
      expect(store.references.allowed(image.id)).toBe(false);
      expect(store.references.allowed(image.id, otherSession)).toBe(false);
    }
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        value: otherSession.id,
        url: web.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await context.setOffline(false);
    const observedSession = await page.evaluate(async () => {
      const response = await fetch("/api/session");
      return {
        status: response.status,
        scope: response.headers.get("X-Slopgrid-Cache-Scope"),
      };
    });
    expect(observedSession).toEqual({
      status: 200,
      scope: cacheScope(otherSession),
    });
    for (const image of chatImages)
      expect(
        await page.evaluate(
          async (id) => (await fetch(`/api/references/${id}`)).status,
          image.id,
        ),
      ).toBe(404);
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

    // Returning to the original identity may recache its conversation. Keep
    // logout coverage distinct from the observed-session-change path above.
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
    await context.setOffline(false);
    expect(
      await page.evaluate(async () => {
        const response = await fetch("/api/session");
        return {
          status: response.status,
          scope: response.headers.get("X-Slopgrid-Cache-Scope"),
        };
      }),
    ).toEqual({ status: 200, scope: cacheScope({ id: owner }) });
    const chat = grids.find((grid) => grid.input.format === "chat-template")!;
    await page.goto(`${web.origin}/grid/${chat.id}`);
    await page.evaluate(
      async (ids) => {
        await Promise.all(ids.map((id) => fetch(`/api/references/${id}`)));
      },
      chatImages.map((image) => image.id),
    );
    await expect
      .poll(() =>
        page.evaluate(
          async (ids) => {
            for (const name of await caches.keys()) {
              const cache = await caches.open(name);
              if (
                (
                  await Promise.all(
                    ids.map((id) => cache.match(`/api/references/${id}`)),
                  )
                ).every(Boolean)
              )
                return true;
            }
            return false;
          },
          chatImages.map((image) => image.id),
        ),
      )
      .toBe(true);
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
    await create(page, { rowValues: ["cat"] });
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
