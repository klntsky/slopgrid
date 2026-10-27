import { test, expect, type Request } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";

test.use({ serviceWorkers: "block" });

test("stream recovery cancels stale HTTP snapshots without rolling back output or thinking", async ({
  page,
  context,
}) => {
  const f = await runtimeFixture();
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<Request>();
  const settled = Promise.withResolvers<void>();
  try {
    await context.addCookies([
      { name: f.cookieName, value: f.owner, url: f.origin },
    ]);
    const grid = f.grid({
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "cat" }] }],
    });
    const transport = f.gridTransport(grid.id);
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const call = await f.call(0);
    call.write({
      content: "Earlier output. ",
      reasoning: "Earlier thinking. ",
    });
    await page.goto(`${f.origin}/grid/${grid.id}`);
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Earlier output.",
    );
    await page.route(
      `${f.origin}/api/grids/${grid.id}`,
      async (route) => {
        try {
          const response = await route.fetch();
          held.resolve(route.request());
          await gate.promise;
          if (!route.request().failure()) await route.fulfill({ response });
        } catch (error) {
          held.reject(error);
          if (!route.request().failure()) throw error;
        } finally {
          settled.resolve();
        }
      },
      { times: 1 },
    );
    transport.blockEvents();
    const request = await held.promise;
    const reads = transport.reads;
    expect(request.failure()).toBeNull();
    call.write({ content: "Newer output.", reasoning: "Newer thinking." });
    transport.blockEvents(false);
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Newer output.",
    );
    await expect.poll(() => request.failure()).not.toBeNull();
    expect(transport.reads).toBe(reads);
    gate.resolve();
    await settled.promise;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Newer output.",
    );
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Newer thinking.");
    call.finish();
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await f.close();
  }
});

test("late HTTP and reconnected stream snapshots cannot roll back content, thinking, title, cost or completion", async ({
  page,
  context,
}) => {
  const f = await runtimeFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await context.addCookies([
      { name: f.cookieName, value: f.owner, url: f.origin },
    ]);
    const grid = f.grid({
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "cat" }] }],
    });
    const endpoint = `${f.origin}/api/grids/${grid.id}`;
    const transport = f.gridTransport(grid.id);
    await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
    const call = await f.call(0);
    call.write({
      content: "# Earlier output\n\n",
      reasoning: "Earlier thinking. ",
    });
    await page.goto(`${f.origin}/grid/${grid.id}`);
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Earlier output",
    );
    const held = Promise.withResolvers<{ request: Request; body: string }>();
    const settled = Promise.withResolvers<void>();
    await page.route(
      endpoint,
      async (route) => {
        try {
          const response = await route.fetch();
          held.resolve({
            request: route.request(),
            body: await response.text(),
          });
          await gate;
          if (!route.request().failure()) await route.fulfill({ response });
        } catch (error) {
          held.reject(error);
          if (!route.request().failure()) throw error;
        } finally {
          settled.resolve();
        }
      },
      { times: 1 },
    );
    transport.blockEvents();
    const { request, body: oldSnapshot } = await held.promise;
    const reads = transport.reads;
    expect(request.failure()).toBeNull();
    call.write({ content: "Newer output.\n", reasoning: "Newer thinking." });
    await f.request(
      `/api/grids/${grid.id}/title`,
      { title: "Newer title" },
      "PATCH",
    );
    transport.blockEvents(false);
    const title = page.getByRole("button", { name: "Edit title", exact: true });
    await expect(title).toHaveText("Newer title");
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Newer output.",
    );
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Newer thinking.");
    await expect.poll(() => request.failure()).not.toBeNull();
    expect(transport.reads).toBe(reads);
    // Observe every DOM commit, so a transient rollback followed by recovery fails too.
    const observations = await page.evaluateHandle(() => {
      const states: {
        title: string;
        content: string;
        price: string;
        spent: string;
      }[] = [];
      const observer = new MutationObserver(() =>
        states.push({
          title:
            document.querySelector('[aria-label="Edit title"]')?.textContent ??
            "",
          content: document.querySelector("article.cell")?.textContent ?? "",
          price:
            document.querySelector(".grid-cost")?.getAttribute("aria-label") ??
            "",
          spent:
            document.querySelector(".grid-spent")?.getAttribute("aria-label") ??
            "",
        }),
      );
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      return { states, stop: () => observer.disconnect() };
    });
    let connections = 0;
    await page.route(endpoint + "/events?**", async (route) => {
      connections++;
      if (connections === 1)
        await route.fulfill({
          contentType: "text/event-stream",
          body: `id: older\ndata: {"snapshot":${oldSnapshot}}\n\n`,
        });
      else await route.continue();
    });
    // Replay an older valid snapshot on reconnection, then reconnect to the real stream.
    await kill(f.web);
    await f.startWeb();
    // Two native EventSource reconnect delays exceed Playwright's default assertion timeout.
    await expect
      .poll(() => connections, { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);
    call.write({ reasoning: " Still advancing." });
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Still advancing.");
    call.finish();
    await expect(page.locator(".grid-cost")).toHaveAttribute(
      "aria-label",
      "Total cost: $0.01",
    );
    const firstStates = await observations.evaluate((value) =>
      value.states.splice(0),
    );
    for (const state of firstStates) {
      expect(state.title).toBe("Newer title");
      expect(state.content).toContain("Newer output.");
      expect(state.content).toContain("Newer thinking.");
    }
    // Releasing the canceled HTTP snapshot after completion must not reopen
    // streaming or restore its old estimate.
    release();
    await settled.promise;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(title).toHaveText("Newer title");
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Still advancing.");
    await expect(page.locator(".grid-cost")).toHaveAttribute(
      "aria-label",
      "Total cost: $0.01",
    );
    const lastStates = await observations.evaluate((value) => {
      value.stop();
      return value.states;
    });
    for (const state of lastStates) {
      expect(state.title).toBe("Newer title");
      expect(state.content).toContain("Newer output.");
      expect(state.content).toContain("Still advancing.");
      expect(state.price).toBe("Total cost: $0.01");
      expect(state.spent).toBe("Total spent: $0.01");
    }
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await f.close();
  }
});
