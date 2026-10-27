import {
  test,
  expect,
  type PlaywrightWorkerArgs,
  type Page,
  type Request,
} from "@playwright/test";
import { runtimeFixture, kill, type GridReadFault } from "../runtime-fixture";
import type { IncomingMessage } from "node:http";
import { currentDefinition } from "../current-grid-fixture";
import { referencePng } from "../reference-image-fixture";
import { expectProgress, finishPublishing } from "./helpers";

for (const prompt of ["billing", "low balance"] as const) {
  test(`terminal billing interruption removes the ${prompt} recovery prompt without blocking another grid's recovery`, async ({
    playwright,
  }) => {
    const fixture = await runtimeFixture({ workers: 2, images: true });
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          name: fixture.cookieName,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          value: fixture.owner,
          url: fixture.origin,
        },
      ]);
      // Seed only saved definitions; the UI and real engine produce every lifecycle transition.
      const definition = currentDefinition({
        format: "image",
        budgetUsd: 0.1,
        parallelWorkers: 2,
        caseAxes: ["rows"],
        rows: [
          { variable: [{ text: "cat" }] },
          { variable: [{ text: "dog" }] },
        ],
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw $ROW1" }],
          },
        },
      });
      const terminal = fixture.grid(definition);
      const unfinished = fixture.grid(definition);
      const page = await context.newPage();
      const adjacent = await context.newPage();
      await page.goto(`${fixture.origin}/grid/${terminal.id}`);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const completed = await fixture.nextImageCall();
      const last = await fixture.nextImageCall();
      completed.finish(referencePng);
      await expectProgress(page, 1, 2);
      const output = page.getByRole("img", {
        name: "Generated image",
        exact: true,
      });
      await expect(output).toBeVisible();
      const savedOutput = await output.getAttribute("src");

      await adjacent.goto(`${fixture.origin}/grid/${unfinished.id}`);
      await adjacent.getByRole("button", { name: "Resume generation" }).click();
      (await fixture.nextImageCall()).fail(402);
      for (const view of [page, adjacent])
        await expect(
          view.getByRole("dialog", {
            name: "OpenRouter credits needed",
            exact: true,
          }),
        ).toBeVisible();
      expect(last.aborted).toBe(false);

      if (prompt === "low balance") {
        fixture.credits.total_credits = 1;
        await page.getByRole("button", { name: "Retry unfinished cells" }).click();
        await expect(
          page.getByRole("dialog", {
            name: "Top up your OpenRouter credits",
            exact: true,
          }),
        ).toBeVisible();
      }
      last.fail(400);
      await expectProgress(page, 2, 2);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Resume generation" }),
      ).toHaveCount(0);
      await expect(output).toHaveAttribute("src", savedOutput!);
      await expect(output).toBeVisible();
      await expect
        .poll(() => fixture.store.get(terminal.id))
        .toMatchObject({
          status: "paused",
          interruption: "billing",
          cells: [{ status: "complete" }, { status: "error" }],
        });
      await page.reload();
      await expectProgress(page, 2, 2);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(output).toHaveAttribute("src", savedOutput!);

      fixture.credits.total_credits = 1;
      await adjacent.getByRole("button", { name: "Retry unfinished cells" }).click();
      const lowBalance = adjacent.getByRole("dialog", {
        name: "Top up your OpenRouter credits",
        exact: true,
      });
      await expect(lowBalance).toBeVisible();
      await lowBalance.getByRole("button", { name: "Continue anyway" }).click();
      (await fixture.nextImageCall()).finish(referencePng);
      (await fixture.nextImageCall()).finish(referencePng);
      await expectProgress(adjacent, 2, 2);
      await expect(adjacent.getByRole("dialog")).toHaveCount(0);
      expect(fixture.imageCalls).toHaveLength(5);

      await page.getByRole("button", { name: "Set Title", exact: true }).click();
      const title = page.getByRole("textbox", { name: "Grid title", exact: true });
      await title.fill("Finished billing grid");
      await title.press("Enter");
      await expect(
        page.getByRole("button", { name: "Edit title", exact: true }),
      ).toHaveText("Finished billing grid");
      await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
      await finishPublishing(page);
      await expect(
        page.getByRole("button", { name: "FORK", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Change visibility", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Copy link", exact: true }),
      ).toBeEnabled();
      await expect(output).toHaveAttribute("src", savedOutput!);
      expect(fixture.imageCalls).toHaveLength(5);
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

for (const entry of ["reload", "stream", "pause", "edit"] as const) {
  test(`generation service outage recovers automatically after ${entry}`, async ({
    playwright,
  }) => {
    test.setTimeout(60000);
    const fixture = await runtimeFixture();
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          name: fixture.cookieName,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          value: fixture.owner,
          url: fixture.origin,
        },
      ]);
      const grid = fixture.grid();
      const page = await context.newPage();
      let unavailableReads = 0;
      page.on("response", (response) => {
        if (
          new URL(response.url()).pathname === `/api/grids/${grid.id}` &&
          response.request().method() === "GET" &&
          response.status() === 503
        )
          unavailableReads++;
      });
      await page.goto(`${fixture.origin}/grid/${grid.id}`);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const call = await fixture.nextCall();
      call.write({ content: "Saved before service outage." });
      call.finish();
      const preview = page.locator(".markdown-preview:visible").first();
      await expect(preview).toContainText("Saved before service outage.");
      await fixture.nextCall();
      await expect(
        page.getByRole("progressbar", { name: "Grid generation" }),
      ).toHaveAttribute("value", "1");
      const document = await preview.elementHandle();
      await kill(fixture.engine.child);
      if (entry === "reload") {
        await page.reload();
      } else {
        const failure = page.waitForResponse(
          (response) =>
            response.url().includes(`/api/grids/${grid.id}`) &&
            response.status() === 503,
        );
        if (entry !== "stream")
          await page
            .getByRole("button", {
              name: entry === "pause" ? "Pause generation" : "EDIT",
              exact: true,
            })
            .click();
        await failure;
        await expect(preview).toContainText("Saved before service outage.");
        expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
      }
      await expect(page.locator(".connection-status")).toContainText(
        "Connection lost. Reconnecting",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "slopgrid", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => unavailableReads, { timeout: 30000 })
        .toBeGreaterThan(4);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const outageDocument = await page.locator("html").elementHandle();
      await fixture.startEngine();
      await expect(preview).toContainText("Saved before service outage.", {
        timeout: 15000,
      });
      await expect(page.locator(".connection-status")).toHaveCount(0, {
        timeout: 20000,
      });
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(await outageDocument!.evaluate((node) => node.isConnected)).toBe(
        true,
      );
      await expect(
        page.getByRole("button", { name: "Resume generation" }),
      ).toBeVisible();
      expect(fixture.calls).toHaveLength(2);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const resumed = await fixture.nextCall();
      resumed.write({ content: "After service recovery." });
      resumed.finish();
      await expect(
        page.locator(".markdown-preview:visible").last(),
      ).toContainText("After service recovery.");
      await expect(
        page.getByRole("progressbar", { name: "Grid generation" }),
      ).toHaveAttribute("value", "2");
      expect(fixture.calls).toHaveLength(3);
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

test("grid recovery stops on navigation and missing grids remain terminal", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid();
    await kill(fixture.engine.child);
    const page = await context.newPage();
    await page.clock.install();
    let gridReads = 0;
    let missingReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/grids/${grid.id}`) gridReads++;
      if (path === `/api/grids/${"0".repeat(48)}`) missingReads++;
    });
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create your own AI model benchmark" }),
    ).toBeVisible();
    const readsBeforeAdvancing = gridReads;
    await page.clock.runFor(5000);
    expect(gridReads).toBe(readsBeforeAdvancing);
    await page.goto(`${fixture.origin}/grid/${"0".repeat(48)}`);
    await expect(page.getByRole("alert")).toContainText("Grid not found");
    await page.clock.runFor(10000);
    expect(missingReads).toBe(1);
    await expect(page.locator(".connection-status")).toHaveCount(0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

async function loadedRecoveryGrid(
  playwright: PlaywrightWorkerArgs["playwright"],
) {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid();
    const transport = fixture.gridTransport(grid.id);
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const saved = await fixture.nextCall();
    saved.write({ content: "Private saved output survives read failures." });
    saved.finish();
    const active = await fixture.nextCall();
    let streamMessages = 0;
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", () => streamMessages++);
    await page.clock.install();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const preview = page.locator(".markdown-preview:visible").first();
    await expect(preview).toContainText(
      "Private saved output survives read failures.",
    );
    await expect.poll(() => streamMessages).toBeGreaterThan(0);
    await page.evaluate(() => undefined);
    await page.clock.pauseAt(
      new Date(await page.evaluate(() => Date.now() + 1000)),
    );
    const document = await preview.elementHandle();
    return {
      fixture,
      browser,
      context,
      grid,
      transport,
      active,
      page,
      preview,
      document,
      async reconnectEvents() {
        const before = streamMessages;
        let advanced = 0;
        transport.blockEvents(false);
        await expect
          .poll(
            async () => {
              if (advanced < 20000) {
                await page.clock.runFor(250);
                advanced += 250;
              }
              return streamMessages;
            },
            { intervals: [10] },
          )
          .toBeGreaterThan(before);
        await expect(page.locator(".connection-status")).toHaveCount(0);
      },
      async close() {
        await browser.close();
        await fixture.close();
      },
    };
  } catch (error) {
    await browser.close();
    await fixture.close();
    throw error;
  }
}

async function gridVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((visibilityState) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: visibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);
}

function finishedGridRead(page: Page, id: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const finished = (request: Request) => {
    if (
      request.method() !== "GET" ||
      new URL(request.url()).pathname !== `/api/grids/${id}`
    )
      return;
    page.off("requestfinished", finished);
    page.off("requestfailed", finished);
    resolve();
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  return promise.then(async () => {
    await page.evaluate(() => undefined);
    await page.clock.runFor(1);
  });
}

async function refetchGrid(page: Page, id: string) {
  const finished = finishedGridRead(page, id);
  await expect(page.locator(".connection-status")).toBeVisible();
  await page.clock.runFor(1001);
  await finished;
}

test("mixed temporary grid read failures preserve output beyond fast retries and recover without replaying mutations", async ({
  playwright,
}) => {
  const scenario = await loadedRecoveryGrid(playwright);
  const { page, grid, transport, preview, document, fixture } = scenario;
  try {
    const faults: GridReadFault[] = [
      { kind: "json", status: 503, code: "UNAVAILABLE" },
      { kind: "json", status: 502, code: "BAD_GATEWAY" },
      { kind: "html", status: 502 },
      { kind: "json", status: 503, code: "PERSISTENCE_UNAVAILABLE" },
      { kind: "html", status: 503 },
      { kind: "json", status: 504, code: "GATEWAY_TIMEOUT" },
      { kind: "html", status: 504 },
      { kind: "reset" },
    ];
    const initialReads = transport.reads;
    transport.fail(faults, { kind: "html", status: 503 });
    transport.blockEvents();
    await refetchGrid(page, grid.id);
    while (transport.reads < initialReads + faults.length + 4) {
      await expect(page.locator(".connection-status")).toContainText(
        "Connection lost. Reconnecting",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(preview).toContainText(
        "Private saved output survives read failures.",
      );
      expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
      const nextRead = finishedGridRead(page, grid.id);
      await page.clock.runFor(20000);
      await nextRead;
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
    const recoveredRead = finishedGridRead(page, grid.id);
    transport.pass();
    await page.clock.runFor(20000);
    await recoveredRead;
    await scenario.reconnectEvents();
    await expect(preview).toContainText(
      "Private saved output survives read failures.",
    );
    expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
    expect(transport.mutations).toBe(0);
    expect(fixture.calls).toHaveLength(2);
  } finally {
    await scenario.close();
  }
});

for (const status of [401, 403, 404]) {
  test(`terminal ${status} grid reads hide protected output without retrying`, async ({
    playwright,
  }) => {
    const scenario = await loadedRecoveryGrid(playwright);
    const { page, grid, transport } = scenario;
    try {
      const initialReads = transport.reads;
      transport.fail([], { kind: "html", status });
      transport.blockEvents();
      await refetchGrid(page, grid.id);
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(
        page.getByText("Private saved output survives read failures."),
      ).toHaveCount(0);
      await expect(page.locator(".connection-status")).toHaveCount(0);
      await page.clock.runFor(120000);
      expect(transport.reads).toBe(initialReads + 1);
      expect(transport.mutations).toBe(0);
    } finally {
      await scenario.close();
    }
  });
  test(`terminal ${status} after a brief successful resume still rechecks permissions`, async ({
    playwright,
  }) => {
    const scenario = await loadedRecoveryGrid(playwright);
    const { page, grid, transport } = scenario;
    try {
      const initialReads = transport.reads;
      transport.blockEvents();
      await refetchGrid(page, grid.id);
      expect(transport.reads).toBe(initialReads + 1);
      await scenario.reconnectEvents();
      const denied = finishedGridRead(page, grid.id);
      transport.fail([], { kind: "html", status });
      transport.blockEvents();
      await expect(page.locator(".connection-status")).toBeVisible();
      await page.clock.runFor(4001);
      await denied;
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(
        page.getByText("Private saved output survives read failures."),
      ).toHaveCount(0);
      await expect(page.locator(".connection-status")).toHaveCount(0);
      await page.clock.runFor(120000);
      expect(transport.reads).toBe(initialReads + 2);
      expect(transport.mutations).toBe(0);
    } finally {
      await scenario.close();
    }
  });
}

for (const format of ["delta-seconds", "HTTP-date"] as const) {
  test(`grid recovery honors ${format} Retry-After before another HTTP read`, async ({
    playwright,
  }) => {
    const scenario = await loadedRecoveryGrid(playwright);
    const { page, grid, transport, preview } = scenario;
    try {
      const initialReads = transport.reads;
      const now = await page.evaluate(() => Date.now());
      transport.fail([
        {
          kind: "html",
          status: 503,
          retryAfter:
            format === "delta-seconds"
              ? "90"
              : new Date(now + 92000).toUTCString(),
        },
      ]);
      transport.blockEvents();
      await refetchGrid(page, grid.id);
      await expect(page.locator(".connection-status")).toBeVisible();
      await page.clock.runFor(89000);
      expect(transport.reads).toBe(initialReads + 1);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const nextRead = finishedGridRead(page, grid.id);
      await page.clock.runFor(3000);
      await nextRead;
      await scenario.reconnectEvents();
      await expect(preview).toContainText(
        "Private saved output survives read failures.",
      );
      expect(transport.reads).toBe(initialReads + 2);
    } finally {
      await scenario.close();
    }
  });
}

for (const suspension of ["hidden", "offline"] as const) {
  for (const cooldown of [false, true]) {
    test(`grid recovery suspends while ${suspension} and resumes ${cooldown ? "after server cooldown" : "immediately when usable"}`, async ({
      playwright,
    }) => {
      const scenario = await loadedRecoveryGrid(playwright);
      const { page, grid, context, transport, preview } = scenario;
      try {
        const initialReads = transport.reads;
        transport.fail([], {
          kind: "html",
          status: 503,
          ...(cooldown ? { retryAfter: "90" } : {}),
        });
        transport.blockEvents();
        await refetchGrid(page, grid.id);
        await expect(page.locator(".connection-status")).toBeVisible();
        if (suspension === "hidden") await gridVisibility(page, "hidden");
        else await context.setOffline(true);
        await page.clock.runFor(30000);
        expect(transport.reads).toBe(initialReads + 1);
        await expect(preview).toContainText(
          "Private saved output survives read failures.",
        );
        await expect(page.getByRole("alert")).toHaveCount(0);
        transport.pass();
        const nextRead = finishedGridRead(page, grid.id);
        if (suspension === "hidden") await gridVisibility(page, "visible");
        else await context.setOffline(false);
        if (cooldown) {
          await page.clock.runFor(59000);
          expect(transport.reads).toBe(initialReads + 1);
          await page.clock.runFor(2000);
        } else {
          await page.clock.runFor(1001);
        }
        await nextRead;
        await scenario.reconnectEvents();
        expect(transport.reads).toBe(initialReads + 2);
        expect(transport.mutations).toBe(0);
      } finally {
        await scenario.close();
      }
    });
  }
}

test("valid SSE state stops redundant GET recovery while live output continues", async ({
  playwright,
}) => {
  const scenario = await loadedRecoveryGrid(playwright);
  const { page, grid, transport, active, fixture } = scenario;
  try {
    transport.fail([], { kind: "html", status: 503 });
    transport.blockEvents();
    await refetchGrid(page, grid.id);
    await expect(page.locator(".connection-status")).toBeVisible();
    active.write({ content: "Fresh state arrived over real SSE." });
    await scenario.reconnectEvents();
    await expect(
      page.locator(".markdown-preview:visible").last(),
    ).toContainText("Fresh state arrived over real SSE.");
    await expect(page.locator(".connection-status")).toHaveCount(0);
    const readsAfterState = transport.reads;
    await page.clock.runFor(120000);
    expect(transport.reads).toBe(readsAfterState);
    active.write({ content: " Streaming is still connected." });
    await expect(
      page.locator(".markdown-preview:visible").last(),
    ).toContainText("Streaming is still connected.");
    expect(transport.mutations).toBe(0);
    expect(fixture.calls).toHaveLength(2);
  } finally {
    await scenario.close();
  }
});

test("valid SSE state promptly aborts an unfinished grid GET response body", async ({
  playwright,
}) => {
  const scenario = await loadedRecoveryGrid(playwright);
  const { page, grid, transport, active, document, fixture } = scenario;
  try {
    const initialReads = transport.reads;
    const startedAt = await page.evaluate(() => Date.now());
    transport.fail([], { kind: "stall" });
    transport.blockEvents();
    const responseArrived = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/grids/${grid.id}`,
    );
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.clock.runFor(1001);
    await transport.waitForRead(initialReads + 1);
    const response = await responseArrived;
    expect(response.status()).toBe(200);
    const request = response.request();
    expect(request.failure()).toBeNull();
    await expect(page.locator(".connection-status")).toBeVisible();
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (failed) => failed === request,
      timeout: 5000,
    });
    active.write({ content: "SSE state supersedes the stalled read." });
    await scenario.reconnectEvents();
    const failed = await aborted;
    expect(failed.failure()).not.toBeNull();
    expect(await page.evaluate(() => Date.now())).toBeLessThan(
      startedAt + 5000,
    );
    await expect(
      page.locator(".markdown-preview:visible").last(),
    ).toContainText("SSE state supersedes the stalled read.");
    await expect(page.locator(".connection-status")).toHaveCount(0);
    expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
    expect(transport.reads).toBe(initialReads + 1);
    await page.clock.runFor(120000);
    expect(transport.reads).toBe(initialReads + 1);
    active.write({ content: " Live output still advances." });
    await expect(
      page.locator(".markdown-preview:visible").last(),
    ).toContainText("Live output still advances.");
    expect(transport.mutations).toBe(0);
    expect(fixture.calls).toHaveLength(2);
  } finally {
    await scenario.close();
  }
});

for (const recovery of ["SSE", "hard navigation"] as const) {
  test(`worker-controlled ${recovery} aborts the real stalled full-grid transport before its body deadline`, async ({
    playwright,
  }) => {
    let gridPath = "";
    let stall = false;
    let reads = 0;
    let proxyClosed = false;
    let upstreamClosed = false;
    const ready = Promise.withResolvers<void>();
    const fixture = await runtimeFixture({
      observeRequest(request, response) {
        if (request.method !== "GET" || request.url !== gridPath) return;
        reads++;
        if (!stall) return;
        response.once("close", () => (proxyClosed = true));
        response.once("pipe", (source: IncomingMessage) => {
          source.unpipe(response);
          source.pause();
          source.once("close", () => (upstreamClosed = true));
          response.write('{"id":');
          ready.resolve();
        });
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
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          url: fixture.origin,
        },
      ]);
      const grid = fixture.grid({ rows: [{ variable: [{ text: "cat" }] }] });
      gridPath = `/api/grids/${grid.id}`;
      const transport = fixture.gridTransport(grid.id);
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
      const active = await fixture.nextCall();
      active.write({ content: "Worker-controlled live output." });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      let streamMessages = 0;
      cdp.on("Network.eventSourceMessageReceived", () => streamMessages++);
      await page.clock.install();
      await page.goto(`${fixture.origin}/grid/${grid.id}`);
      await expect
        .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
        .toBe(true);
      await expect.poll(() => streamMessages).toBeGreaterThan(0);
      await page.evaluate(async (path) => {
        const response = await fetch(path);
        await response.text();
      }, gridPath);
      await page.clock.pauseAt(
        new Date(await page.evaluate(() => Date.now() + 1000)),
      );
      const initialReads = reads;
      const startedAt = await page.evaluate(() => Date.now());
      stall = true;
      transport.blockEvents();
      await expect(page.locator(".connection-status")).toBeVisible();
      await page.clock.runFor(1001);
      await ready.promise;
      const stalledAt = Date.now();
      expect(reads).toBe(initialReads + 1);
      if (recovery === "SSE") {
        const before = streamMessages;
        active.write({ content: " SSE superseded the worker's stalled read." });
        transport.blockEvents(false);
        let advanced = 0;
        await expect
          .poll(
            async () => {
              if (advanced < 4000) {
                await page.clock.runFor(250);
                advanced += 250;
              }
              return streamMessages;
            },
            { intervals: [10] },
          )
          .toBeGreaterThan(before);
        await expect(page.locator(".markdown-preview:visible")).toContainText(
          "SSE superseded the worker's stalled read.",
        );
        await expect(page.locator(".connection-status")).toHaveCount(0);
      } else {
        await page.goto(`${fixture.origin}/`);
        await expect(
          page.getByRole("heading", {
            name: "Create your own AI model benchmark",
          }),
        ).toBeVisible();
      }
      await expect.poll(() => proxyClosed && upstreamClosed).toBe(true);
      expect(Date.now() - stalledAt).toBeLessThan(15000);
      expect(await page.evaluate(() => Date.now())).toBeLessThan(
        startedAt + 15000,
      );
      await page.clock.runFor(30000);
      expect(reads).toBe(initialReads + 1);
      expect(transport.mutations).toBe(0);
      expect(fixture.calls).toHaveLength(1);
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

test("open browsers reconnect to a replaced web process while markdown, thinking and website assets continue streaming", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture({ workers: 2 });
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const markdown = fixture.grid({
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "markdown" }] }],
    });
    const website = fixture.grid({
      format: "html",
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "website" }] }],
    });
    const pages = [await context.newPage(), await context.newPage()];
    for (const [index, grid] of [markdown, website].entries()) {
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
      (await fixture.call(index)).write({ reasoning: "Before restart. " });
      await pages[index].goto(`${fixture.origin}/grid/${grid.id}`);
      await expect(
        pages[index].getByRole("region", { name: /^Thinking:/ }),
      ).toContainText("Before restart.");
    }
    const [md, html] = pages;
    const [mdCall, htmlCall] = fixture.calls;
    mdCall.write({ content: "# Before restart\n\n" });
    const first =
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Website survived</h1><p id="module">Waiting</p><script type="module" src="app.js"></script>';
    htmlCall.write({
      content:
        '{"files":[{"path":"index.html","content":' + JSON.stringify(first),
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "Before restart",
    );
    await expect(
      html.frameLocator("iframe:visible").getByRole("heading"),
    ).toHaveText("Website survived");
    // These document handles also prove recovery happens without a page reload.
    const documents = await Promise.all(
      pages.map((p) => p.locator("html").elementHandle()),
    );
    await kill(fixture.web);
    mdCall.write({
      reasoning: "During downtime. ",
      content: "During downtime.\n\n",
    });
    await fixture.startWeb();
    htmlCall.write({
      reasoning: "After restart.",
      content:
        '},{"path":"style.css","content":"body { color: rgb(12, 34, 56); }"},{"path":"app.js","content":' +
        JSON.stringify(
          "document.getElementById('module').textContent='Module after restart';",
        ),
    });
    mdCall.write({
      reasoning: "After restart.",
      content: "## After restart\n",
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "After restart",
    );
    const frame = html.frameLocator("iframe:visible");
    await expect(frame.getByText("Module after restart")).toBeVisible();
    // Check that the generated stylesheet was fetched by the new web process.
    await expect(frame.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
    for (const p of pages) {
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
      await expect(p.getByRole("region", { name: /^Thinking:/ })).toContainText(
        "After restart.",
      );
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
    }
    mdCall.finish();
    htmlCall.write({ content: "}]}" });
    htmlCall.finish();
    for (const p of pages)
      await expect(p.locator(".grid-cost")).toHaveAttribute(
        "aria-label",
        "Total cost: $0.01",
      );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(frame.getByText("Module after restart")).toBeVisible();
    for (const document of documents)
      expect(await document!.evaluate((el) => el.isConnected)).toBe(true);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.aborted)).toEqual([false, false]);
    expect(fixture.store.billing.page(fixture.owner, 0).costUsd).toBe(0.0246);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("running chat output stays readable offline and catches up after reconnecting", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid(
      currentDefinition({
        format: "chat-template",
        budgetUsd: 0.1,
        parameters: {
          input: {
            kind: "common",
            value: [
              { role: "user", content: "Keep this conversation visible." },
              { role: "unfilled", content: "" },
            ],
          },
          effort: { kind: "common", value: "none" },
        },
      }),
    );
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const call = await fixture.nextCall();
    call.write({ content: "Before disconnect. " });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const preview = page.locator(".conversation-preview");
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    const document = await preview.elementHandle();

    await context.setOffline(true);
    await expect(preview).toBeVisible();
    await expect(preview.locator('[data-role="user"]')).toHaveText(
      "Keep this conversation visible.",
    );
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    await expect(page.locator(".connection-status")).toContainText(
      "Connection lost. Reconnecting",
    );
    expect(await document!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await expect(page.locator(".markdown-raw")).toContainText(
      "Before disconnect.",
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await page
      .getByRole("button", { name: "Expand Chat completion", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: /^Expanded output:/ }),
    ).toContainText("Before disconnect.");
    await page
      .getByRole("button", { name: "Collapse Chat completion", exact: true })
      .click();

    call.write({ content: "During disconnect. " });
    await context.setOffline(false);
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect.",
    );
    await expect(page.locator(".connection-status")).toHaveCount(0);
    call.write({ content: "After reconnect." });
    call.finish();
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect. After reconnect.",
    );
    await expect(
      page.getByRole("link", { name: "Open output", exact: true }),
    ).toBeVisible();
    expect(fixture.calls).toHaveLength(1);
    expect(call.aborted).toBe(false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("loaded SVG, website and image output survives disconnection without losing website state", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture({ workers: 3, images: true });
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const svg = fixture.grid({
      format: "svg",
      rows: [{ variable: [{ text: "svg" }] }],
    });
    const website = fixture.grid({
      format: "html",
      rows: [{ variable: [{ text: "website" }] }],
    });
    const image = fixture.grid(
      currentDefinition({
        format: "image",
        budgetUsd: 0.1,
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw image" }],
          },
        },
      }),
    );
    for (const grid of [svg, website, image])
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
    const svgCall = await fixture.nextCall();
    const websiteCall = await fixture.nextCall();
    svgCall.write({
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/>',
    });
    websiteCall.write({
      content:
        '{"files":[{"path":"index.html","content":' +
        JSON.stringify(
          '<h1>Loaded website</h1><input aria-label="Local state">',
        ).slice(0, -1),
    });
    (await fixture.nextImageCall()).finish(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const [svgPage, websitePage, imagePage] = await Promise.all(
      [svg, website, image].map(async (grid) => {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/grid/${grid.id}`);
        return page;
      }),
    );
    const svgPreview = svgPage.getByRole("img", { name: "SVG preview" });
    const imageOutput = imagePage.getByRole("img", { name: "Generated image" });
    await expect(svgPreview).toBeVisible();
    await expect
      .poll(() =>
        imageOutput.evaluate((element) =>
          element instanceof HTMLImageElement ? element.naturalWidth : 0,
        ),
      )
      .toBe(1);
    const frame = websitePage.frameLocator('iframe[aria-hidden="false"]');
    await frame.getByRole("textbox", { name: "Local state" }).fill("Keep me");
    const websiteDocument = await frame.locator("html").elementHandle();
    const svgElement = await svgPreview.elementHandle();
    const imageElement = await imageOutput.elementHandle();

    await context.setOffline(true);
    await expect(svgPreview).toBeVisible();
    await expect(imageOutput).toBeVisible();
    await expect(frame.getByRole("heading")).toHaveText("Loaded website");
    await expect(frame.getByRole("textbox")).toHaveValue("Keep me");
    for (const element of [svgElement, imageElement, websiteDocument])
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
    for (const page of [svgPage, websitePage])
      await expect(page.locator(".connection-status")).toContainText(
        "Connection lost. Reconnecting",
      );

    svgCall.write({
      content: '<circle cx="20" cy="20" r="10" fill="blue"/></svg>',
    });
    svgCall.finish();
    websiteCall.write({ content: '<p>After reconnect</p>"}]}' });
    websiteCall.finish();
    await context.setOffline(false);
    await expect(
      svgPage.getByRole("img", { name: "Generated SVG" }),
    ).toBeVisible();
    await expect(frame.getByText("After reconnect")).toBeVisible();
    await expect(websitePage.locator(".connection-status")).toHaveCount(0);
    await expect(
      websitePage.getByRole("link", { name: "Open output", exact: true }),
    ).toBeVisible();
    const outputURL = await websitePage
      .getByRole("link", { name: "Open output", exact: true })
      .getAttribute("href");
    await expect(
      websitePage.locator('iframe[aria-hidden="false"]'),
    ).toHaveAttribute("src", outputURL!);

    // A completed website must retain its live document, not load a cached copy.
    await frame.getByRole("textbox").fill("Completed local state");
    const completedDocument = await frame.locator("html").elementHandle();
    await context.setOffline(true);
    await expect(frame.getByRole("textbox")).toHaveValue(
      "Completed local state",
    );
    expect(await completedDocument!.evaluate((node) => node.isConnected)).toBe(
      true,
    );
    await context.setOffline(false);
    await expect(frame.getByRole("textbox")).toHaveValue(
      "Completed local state",
    );
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.every((call) => !call.aborted)).toBe(true);
    expect(fixture.imageCalls).toHaveLength(1);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
