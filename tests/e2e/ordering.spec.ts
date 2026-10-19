import { test, expect } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";

test("delayed HTTP snapshots cannot replace newer drafts within the same engine epoch", async ({
  page,
  context,
}) => {
  const f = await runtimeFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  try {
    await context.addCookies([
      { name: f.cookieName, value: f.owner, url: f.origin },
    ]);
    const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
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
    let captured!: () => void;
    const held = new Promise<void>((resolve) => {
      captured = resolve;
    });
    await page.route(
      `${f.origin}/api/grids/${grid.id}`,
      async (route) => {
        const response = await route.fetch();
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
    const before = await f.engine.api.getGrid(grid.id);
    call.write({ content: "Newer output.", reasoning: "Newer thinking." });
    await expect(page.locator(".markdown-preview:visible")).toContainText(
      "Newer output.",
    );
    const after = await f.engine.api.getGrid(grid.id);
    expect(after.version.epoch).toBe(before.version.epoch);
    expect(after.version.sequence).toBeGreaterThan(before.version.sequence);
    // No further chunks can repair a rollback after the delayed query arrives.
    release();
    await delivery;
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
    release();
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
    const grid = f.grid({ rows: { kind: "variable", values: ["cat"] } });
    const endpoint = `${f.origin}/api/grids/${grid.id}`;
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
    let captured!: (body: string) => void;
    const held = new Promise<string>((resolve) => {
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
        captured(await response.text());
        await gate;
        await route.fulfill({ response });
        delivered();
      },
      { times: 1 },
    );
    // Trigger the real query's focus refetch, then delay its real HTTP response.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    const oldSnapshot = await held;
    call.write({ content: "Newer output.\n", reasoning: "Newer thinking." });
    await f.request(
      `/api/grids/${grid.id}/title`,
      { title: "Newer title" },
      "PATCH",
    );
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
    expect(firstStates.length).toBeGreaterThan(0);
    for (const state of firstStates) {
      expect(state.title).toBe("Newer title");
      expect(state.content).toContain("Newer output.");
      expect(state.content).toContain("Newer thinking.");
    }
    // The outstanding HTTP response says "running" and has the old estimate.
    // Deliver it after completion: it must not reopen streaming or restore that price.
    release();
    await delivery;
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
    expect(f.calls).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await f.close();
  }
});
