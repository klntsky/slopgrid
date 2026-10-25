import { test, expect, type PlaywrightWorkerArgs } from "@playwright/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runtimeFixture } from "../runtime-fixture";

async function trafficGrid(playwright: PlaywrightWorkerArgs["playwright"]) {
  let gridPath = "";
  let reads = 0;
  let bodyBytes = 0;
  let mutations = 0;
  let flap = false;
  let silent = false;
  const streams: {
    response: ServerResponse;
    since: string | null;
    valid: boolean;
  }[] = [];
  const fixture = await runtimeFixture({
    observeRequest(request, response) {
      const url = new URL(request.url ?? "/", "https://localhost");
      if (url.pathname === gridPath && request.method === "GET") {
        reads++;
        response.once("pipe", (source: IncomingMessage) => {
          source.on("data", (chunk: Buffer) => {
            bodyBytes += chunk.byteLength;
          });
        });
      } else if (url.pathname === `${gridPath}/events`) {
        const stream = {
          response,
          since: url.searchParams.get("since"),
          valid: false,
        };
        streams.push(stream);
        response.once("pipe", (source: IncomingMessage) => {
          if (silent) {
            source.unpipe(response);
            source.pause();
            response.flushHeaders();
            return;
          }
          let frame = "";
          source.on("data", (chunk: Buffer) => {
            frame += chunk.toString();
            if (
              !stream.valid &&
              frame.includes("\ndata: ") &&
              frame.endsWith("\n\n")
            ) {
              stream.valid = true;
              if (flap) setImmediate(() => response.end());
            }
          });
        });
      } else if (
        url.pathname.startsWith(`${gridPath}/`) &&
        request.method === "POST"
      ) {
        mutations++;
      }
    },
  });
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
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
    const grid = fixture.grid();
    gridPath = `/api/grids/${grid.id}`;
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const active = await fixture.nextCall();
    active.write({
      content: `<!--${"x".repeat(128 * 1024)}-->\n\nLarge live draft.`,
    });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("Large live draft.");
    await expect.poll(() => streams[0]?.valid).toBe(true);
    await page.clock.pauseAt(
      new Date(await page.evaluate(() => Date.now() + 1000)),
    );
    return {
      fixture,
      page,
      context,
      active,
      streams,
      get reads() {
        return reads;
      },
      get bodyBytes() {
        return bodyBytes;
      },
      get mutations() {
        return mutations;
      },
      flap() {
        flap = true;
        streams.at(-1)!.response.end();
      },
      silence() {
        silent = true;
        streams.at(-1)!.response.end();
      },
      restore() {
        silent = false;
        flap = false;
      },
      async online() {
        const before = streams.filter((stream) => stream.valid).length;
        let advanced = 0;
        await context.setOffline(false);
        await expect
          .poll(
            async () => {
              if (advanced < 2000) {
                await page.clock.runFor(100);
                advanced += 100;
              }
              return streams.filter((stream) => stream.valid).length;
            },
            { intervals: [10] },
          )
          .toBeGreaterThan(before);
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

test("valid-message SSE flaps retain exponential backoff and transfer no extra full-grid bodies", async ({
  playwright,
}, testInfo) => {
  const scenario = await trafficGrid(playwright);
  const { page, streams } = scenario;
  try {
    const initialReads = scenario.reads;
    const initialBytes = scenario.bodyBytes;
    expect(initialBytes).toBeGreaterThanOrEqual(128 * 1024);
    scenario.flap();
    for (let failure = 1; failure <= 4; failure++) {
      await expect(page.locator(".connection-status")).toBeVisible();
      const count = streams.length;
      const ceiling = 1000 * 2 ** (failure - 1);
      await page.clock.runFor(ceiling / 2 - 1);
      expect(streams).toHaveLength(count);
      await page.clock.runFor(ceiling / 2 + 2);
      await expect.poll(() => streams.length).toBe(count + 1);
      await expect.poll(() => streams.at(-1)?.valid).toBe(true);
      expect(streams.at(-1)?.since).toBeTruthy();
      expect(scenario.reads).toBe(initialReads);
      expect(scenario.bodyBytes).toBe(initialBytes);
    }
    expect(streams).toHaveLength(5);
    expect(scenario.mutations).toBe(0);
    expect(scenario.fixture.calls).toHaveLength(1);
  } finally {
    await testInfo.attach("stream-recovery-traffic", {
      body: JSON.stringify({
        reads: scenario.reads,
        bodyBytes: scenario.bodyBytes,
        streams: streams.map(({ since, valid }) => ({ since, valid })),
      }),
      contentType: "application/json",
    });
    await scenario.close();
  }
});

test("silent resumed SSE expires after fifteen seconds, checks the grid once, and cancels on navigation", async ({
  playwright,
}) => {
  const scenario = await trafficGrid(playwright);
  const { page, streams } = scenario;
  try {
    const initialReads = scenario.reads;
    scenario.silence();
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.clock.runFor(1001);
    await expect.poll(() => streams.length).toBe(2);
    await page.evaluate(() => undefined);
    expect(streams[1].since).toBeTruthy();
    await page.clock.runFor(14000);
    expect(scenario.reads).toBe(initialReads);
    await page.clock.runFor(1001);
    await expect.poll(() => scenario.reads).toBe(initialReads + 1);
    await page.clock.runFor(2001);
    await expect.poll(() => streams.length).toBe(3);
    await page.clock.runFor(15001);
    await page.evaluate(() => undefined);
    expect(scenario.reads).toBe(initialReads + 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.clock.runFor(4001);
    await expect.poll(() => streams.length).toBe(4);
    await page.clock.runFor(1000);
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create your own AI model benchmark" }),
    ).toBeVisible();
    const count = streams.length;
    await page.clock.runFor(120000);
    expect(streams).toHaveLength(count);
    expect(scenario.reads).toBe(initialReads + 1);
    expect(scenario.mutations).toBe(0);
  } finally {
    await scenario.close();
  }
});

test("healthy resumed SSE cancels its first-message deadline and suppresses focus and online full-grid reads", async ({
  playwright,
}) => {
  const scenario = await trafficGrid(playwright);
  const { page, context, streams, active } = scenario;
  try {
    const initialReads = scenario.reads;
    await context.setOffline(true);
    await expect(page.locator(".connection-status")).toBeVisible();
    active.write({ content: " Caught up through the cursor." });
    await scenario.online();
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("Caught up through the cursor.");
    await expect(page.locator(".connection-status")).toHaveCount(0);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
    );
    const count = streams.length;
    await page.clock.runFor(31000);
    expect(streams).toHaveLength(count);
    expect(scenario.reads).toBe(initialReads);
    expect(scenario.mutations).toBe(0);
  } finally {
    await scenario.close();
  }
});

test("thirty seconds from the first valid message resets backoff despite a recent update", async ({
  playwright,
}) => {
  const scenario = await trafficGrid(playwright);
  const { page, streams, active } = scenario;
  try {
    const initialReads = scenario.reads;
    scenario.flap();
    for (const delay of [1001, 2001]) {
      await expect(page.locator(".connection-status")).toBeVisible();
      const count = streams.length;
      await page.clock.runFor(delay);
      await expect.poll(() => streams.length).toBe(count + 1);
      await expect.poll(() => streams.at(-1)?.valid).toBe(true);
    }
    await expect(page.locator(".connection-status")).toBeVisible();
    scenario.restore();
    await page.clock.runFor(4001);
    await expect.poll(() => streams.length).toBe(4);
    await expect(page.locator(".connection-status")).toHaveCount(0);
    await page.clock.runFor(20000);
    active.write({ content: " Recent message on a sustained healthy stream." });
    await expect(
      page.locator(".markdown-preview:visible").first(),
    ).toContainText("Recent message on a sustained healthy stream.");
    await page.clock.runFor(10001);
    streams.at(-1)!.response.end();
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.clock.runFor(1001);
    await expect.poll(() => streams.length).toBe(5);
    await expect(page.locator(".connection-status")).toHaveCount(0);
    expect(scenario.reads).toBe(initialReads);
    expect(scenario.mutations).toBe(0);
  } finally {
    await scenario.close();
  }
});

test("an offline cycle preserves the backoff budget of short valid streams", async ({
  playwright,
}) => {
  const scenario = await trafficGrid(playwright);
  const { page, context, streams } = scenario;
  try {
    const initialReads = scenario.reads;
    const initialBytes = scenario.bodyBytes;
    scenario.flap();
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.clock.runFor(1001);
    await expect.poll(() => streams.length).toBe(2);
    await expect.poll(() => streams.at(-1)?.valid).toBe(true);
    await expect(page.locator(".connection-status")).toBeVisible();
    await context.setOffline(true);
    await scenario.online();
    await expect.poll(() => streams.length).toBe(3);
    await expect.poll(() => streams.at(-1)?.valid).toBe(true);
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.clock.runFor(1999);
    expect(streams).toHaveLength(3);
    await page.clock.runFor(2002);
    await expect.poll(() => streams.length).toBe(4);
    expect(scenario.reads).toBe(initialReads);
    expect(scenario.bodyBytes).toBe(initialBytes);
    expect(scenario.mutations).toBe(0);
  } finally {
    await scenario.close();
  }
});
