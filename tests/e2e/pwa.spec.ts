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
              format === "markdown"
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
  } finally {
    await browser.close();
    await web.close();
    await generation.close();
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline cache schema migration preserves judged grouping, retained outputs, and account isolation", async ({
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
    // Seed the previous release's caches before the new worker first activates.
    await context.route("**/fixture/pwa-cache", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Cache migration</title>",
      }),
    );
    const page = await context.newPage();
    await page.goto("/fixture/pwa-cache");
    const snapshot = (judged: boolean) => {
      const input: GridInput = {
        format: "markdown",
        prompt: judged
          ? "Saved judged $COLUMN outputs"
          : "Saved independent outputs",
        rows: { kind: "model", values: ["fixture/text"] },
        columns: {
          kind: "variable",
          values: judged ? ["shared", "shared", "independent"] : ["one", "two"],
        },
        model: "fixture/text",
        effort: "none",
        budgetUsd: 1,
        ...(judged
          ? {
              judge: {
                criteria: [{ text: "Is this saved?", correctAnswer: true }],
                model: "fixture/text",
                effort: "default",
              },
            }
          : {}),
      };
      const ids = input.columns.values.map(() => token());
      const artifacts = ids.map(() => token());
      return {
        id: token(),
        input,
        status: judged ? "paused" : "complete",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        live: false,
        canEdit: false,
        canPublish: false,
        author: null,
        cells: expandGrid(input).map((cell, index) => {
          const status = judged
            ? (["pending", "error", "complete"] as const)[index]
            : "complete";
          return {
            ...cell,
            id: ids[index],
            status,
            outputReady: true,
            artifactId: artifacts[judged && index < 2 ? 0 : index],
            generationSourceId: judged ? ids[index < 2 ? 0 : index] : undefined,
            generationStatus: judged ? "complete" : undefined,
            outputURL: `${server.origin}/outputs/${ids[index]}`,
            thinkingURL: `/outputs/${ids[index]}/thinking/${token()}`,
            usage: { costUsd: judged && index < 2 ? 0.25 : index ? 0.5 : 0.25 },
            judge: judged
              ? {
                  model: "fixture/text",
                  effort: "default",
                  status,
                  ...(status === "error" ? { error: "Saved judge error" } : {}),
                  ...(status === "complete"
                    ? {
                        results: [
                          { verdict: true, explanation: "Saved verdict" },
                        ],
                      }
                    : {}),
                }
              : undefined,
          };
        }),
      };
    };
    const judged = snapshot(true);
    const independent = snapshot(false);
    const canonicalSeed = snapshot(false);
    const canonical = {
      ...canonicalSeed,
      cells: canonicalSeed.cells.map(
        ({ generationSourceId, generationStatus, ...cell }) => ({
          ...cell,
          generationId: token(),
        }),
      ),
    };
    const privateGrid = snapshot(true);
    const scope = "migration-owner";
    const otherScope = "migration-other";
    const jsonRecord = (grid: unknown, id: string, partition: string) => ({
      url: `/api/grids/${id}`,
      body: JSON.stringify(grid),
      headers: {
        "Content-Type": "application/json",
        "X-Slopgrid-Cache-Scope": partition,
      },
    });
    const outputs = [judged, independent].flatMap((grid) =>
      grid.cells.flatMap((cell) =>
        [
          [`/outputs/${cell.id}?raw=1`, `# Retained output ${cell.id}`],
          [`/outputs/${cell.id}/download`, `Saved download ${cell.id}`],
          [cell.thinkingURL, `Saved thinking ${cell.id}`],
        ].map(([url, body]) => ({
          url,
          body,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Slopgrid-Cache-Scope": scope,
            "X-Slopgrid-Output-Ready": "1",
            "Content-Security-Policy": "default-src 'none'",
          },
        })),
      ),
    );
    const canonicalRecord = jsonRecord(canonical, canonical.id, scope);
    canonicalRecord.body = JSON.stringify(canonical, null, 2) + "\n";
    const partitions = [
      {
        name: `slopgrid-data-v1-${scope}`,
        records: [
          outputs[0],
          jsonRecord(judged, judged.id, scope),
          jsonRecord(independent, independent.id, scope),
          canonicalRecord,
          ...outputs.slice(1),
        ],
      },
      {
        name: `slopgrid-data-v1-${otherScope}`,
        records: [
          jsonRecord({ ...privateGrid, id: judged.id }, judged.id, otherScope),
          jsonRecord(privateGrid, privateGrid.id, otherScope),
          {
            ...outputs[0],
            url: `/outputs/${privateGrid.cells[0].id}?raw=1`,
            body: "Another account's private output",
            headers: {
              ...outputs[0].headers,
              "X-Slopgrid-Cache-Scope": otherScope,
            },
          },
        ],
      },
    ];
    await page.evaluate(
      async ({ scope, partitions }) => {
        await (
          await caches.open("slopgrid-state-v1")
        ).put("/__offline_scope", new Response(scope));
        for (const { name, records } of partitions) {
          const cache = await caches.open(name);
          for (const { url, body, headers } of records)
            await cache.put(url, new Response(body, { headers }));
        }
      },
      { scope, partitions },
    );
    const before = partitions.map(({ name, records }) => ({
      name,
      records: records.map(({ url, body, headers }) => ({
        url: new URL(url, server.origin).href,
        body,
        headers: Object.entries(headers)
          .map(([key, value]) => [key.toLowerCase(), value])
          .sort(([left], [right]) => left.localeCompare(right)),
      })),
    }));
    const requests: string[] = [];
    context.on("request", (request) =>
      requests.push(new URL(request.url()).pathname),
    );
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await caches.open("slopgrid-state-v1");
          return (await state.match("/__offline_schema"))?.json();
        }),
      )
      .toEqual({ version: 2 });
    // Activation performs no API, generation, judgment, or output fetches.
    expect(
      requests.filter(
        (path) => path.startsWith("/api/") || path.startsWith("/outputs/"),
      ),
    ).toEqual([]);
    type LegacyCachedGrid = {
      cells: {
        id: string;
        generationSourceId?: string;
        generationStatus?: string;
        [field: string]: unknown;
      }[];
      [field: string]: unknown;
    };
    const expected = before.map(({ name, records }) => ({
      name,
      records: records.map((record) => {
        const path = new URL(record.url).pathname;
        if (
          !path.startsWith("/api/grids/") ||
          path === `/api/grids/${canonical.id}`
        )
          return record;
        // These bytes were serialized from the test-owned snapshot records above.
        const grid = JSON.parse(record.body) as LegacyCachedGrid;
        const cells = grid.cells.map(
          ({ generationSourceId, generationStatus, ...cell }) => ({
            ...cell,
            generationId: "g:" + (generationSourceId || cell.id),
          }),
        );
        return { ...record, body: JSON.stringify({ ...grid, cells }) };
      }),
    }));
    // Exact ordering, headers, canonical bytes, output bytes, and verdicts survive.
    const after = await page.evaluate(
      async (names) => {
        return Promise.all(
          names.map(async (name) => {
            const cache = await caches.open(name);
            return {
              name,
              records: await Promise.all(
                (await cache.keys()).map(async (request) => {
                  const response = (await cache.match(request))!;
                  return {
                    url: request.url,
                    body: await response.text(),
                    headers: [...response.headers.entries()],
                  };
                }),
              ),
            };
          }),
        );
      },
      partitions.map(({ name }) => name),
    );
    expect(after).toEqual(expected);
    expect(
      await page.evaluate(async () =>
        (await (
          await caches.open("slopgrid-state-v1")
        ).match("/__offline_scope"))!.text(),
      ),
    ).toBe(scope);
    await context.setOffline(true);
    for (const grid of [judged, independent]) {
      await page.goto(`/grid/${grid.id}`);
      await expect(page.locator("article.cell")).toHaveCount(grid.cells.length);
      await expect(page.locator(".grid-cost")).toHaveAttribute(
        "aria-label",
        "Total cost: $0.75",
      );
      for (const cell of grid.cells) {
        await expect(
          page.getByRole("heading", { name: `Retained output ${cell.id}` }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            async (url) => (await fetch(url)).text(),
            `/outputs/${cell.id}/download`,
          ),
        ).toBe(`Saved download ${cell.id}`);
        expect(
          await page.evaluate(
            async (url) => (await fetch(url)).text(),
            cell.thinkingURL,
          ),
        ).toBe(`Saved thinking ${cell.id}`);
      }
    }
    for (const url of [
      `/api/grids/${privateGrid.id}`,
      `/outputs/${privateGrid.cells[0].id}?raw=1`,
    ]) {
      const denied = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return { status: response.status, body: await response.text() };
      }, url);
      expect(denied.status).toBe(503);
      expect(denied.body).not.toContain("Another account");
    }
    await page.evaluate(() =>
      fetch("/api/auth/logout", { method: "POST" }).catch(() => {}),
    );
    expect(
      await page.evaluate(async () =>
        (await caches.keys()).filter((name) =>
          name.startsWith("slopgrid-data-v1-"),
        ),
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        async (id) => (await fetch(`/api/grids/${id}`)).status,
        judged.id,
      ),
    ).toBe(503);
  } finally {
    await browser.close();
    await server.close();
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
