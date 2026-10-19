import { test, expect } from "@playwright/test";
import { runtimeFixture } from "../runtime-fixture";

test("thinking follows streaming text until scrolled up and resumes at the bottom through completion", async ({
  browser,
}) => {
  const fixture = await runtimeFixture();
  const context = await browser.newContext({
    viewport: { width: 900, height: 650 },
  });
  try {
    await context.addCookies([
      { name: fixture.cookieName, value: fixture.owner, url: fixture.origin },
    ]);
    const grid = fixture.grid({
      rows: { kind: "variable", values: ["thinking"] },
    });
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const call = await fixture.call(0);
    const paragraph =
      "Thinking through the details without inserting newlines. ".repeat(200);
    call.write({ reasoning: paragraph + "First marker." });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const trace = page.getByRole("region", { name: /^Thinking:/ });
    const top = () => trace.evaluate((el) => el.scrollTop);
    const bottomGap = () =>
      trace.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect(trace).toContainText("First marker.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(2);
    for (let chunk = 0; chunk < 4; chunk++) {
      call.write({ reasoning: paragraph + `Burst ${chunk}.` });
      await page.setViewportSize({ width: chunk % 2 ? 900 : 750, height: 650 });
      await expect(trace).toContainText(`Burst ${chunk}.`);
      await expect.poll(bottomGap).toBeLessThanOrEqual(2);
    }
    await trace.hover();
    await page.mouse.wheel(0, -400);
    await expect.poll(bottomGap).toBeGreaterThan(200);
    const reading = await top();
    call.write({ reasoning: paragraph + "Second marker." });
    await expect(trace).toContainText("Second marker.");
    await expect.poll(top).toBeCloseTo(reading, 0);
    await page.mouse.wheel(0, 100000);
    await expect.poll(bottomGap).toBeLessThanOrEqual(2);
    call.write({ reasoning: paragraph + "Third marker." });
    await expect(trace).toContainText("Third marker.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(2);
    // An explicit thinking choice survives output arrival and the saved-text fetch.
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    call.write({
      content: "# Finished output",
      reasoning: paragraph + "Final marker.",
    });
    call.finish();
    await expect(page.locator(".grid-cost")).toHaveAttribute(
      "aria-label",
      "Total cost: $0.01",
    );
    await expect(trace).toContainText("Final marker.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
    await fixture.close();
  }
});

test("thinking-only token exhaustion explains the failure, retains charges and closes live updates", async ({
  browser,
}) => {
  const fixture = await runtimeFixture();
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: fixture.cookieName, value: fixture.owner, url: fixture.origin },
    ]);
    const grid = fixture.grid({
      rows: { kind: "variable", values: ["exhausted", "partial", "early"] },
    });
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const page = await context.newPage();
    const streams = new Set<import("@playwright/test").Request>();
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/events"))
        streams.add(request);
    });
    page.on("requestfinished", (request) => streams.delete(request));
    page.on("requestfailed", (request) => streams.delete(request));
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect.poll(() => streams.size).toBe(1);
    const exhausted = await fixture.call(0);
    exhausted.write({ reasoning: "Still considering the answer." });
    exhausted.finish(0.0123, {
      reason: "length",
      outputTokens: 1000,
      reasoningTokens: 1000,
    });
    const message =
      /1K output token limit on thinking without producing output/;
    await expect(page.getByText(message)).toBeVisible();
    const partial = await fixture.call(1);
    partial.write({ reasoning: "Some thought.", content: "Unfinished answer" });
    partial.finish(0.0123, {
      reason: "length",
      outputTokens: 1000,
      reasoningTokens: 980,
    });
    const early = await fixture.call(2);
    early.write({ reasoning: "Stopped below the requested limit." });
    early.finish(0.0123, {
      reason: "length",
      outputTokens: 100,
      reasoningTokens: 100,
    });
    await expect(
      page.getByText(/The model did not complete its response/),
    ).toHaveCount(2);
    await expect.poll(() => streams.size).toBe(0);
    await expect(page.locator(".grid-cost")).toHaveAttribute(
      "aria-label",
      "Total cost: $0.00",
    );
    await expect(page.locator(".grid-spent")).toHaveAttribute(
      "aria-label",
      "Total spent: $0.03",
    );
    await page.reload();
    await expect(page.getByText(message)).toBeVisible();
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }).first(),
    ).toContainText("Still considering the answer.");
  } finally {
    await context.close();
    await fixture.close();
  }
});

test("SVG streaming advances behind thinking and survives view switches through completion", async ({
  browser,
}) => {
  const fixture = await runtimeFixture();
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: fixture.cookieName, value: fixture.owner, url: fixture.origin },
    ]);
    const grid = fixture.grid({
      format: "svg",
      rows: { kind: "variable", values: ["svg"] },
    });
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const call = await fixture.call(0);
    call.write({ reasoning: "Thinking before drawing." });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const trace = page.getByRole("region", { name: /^Thinking:/ });
    await expect(trace).toContainText("Thinking before drawing.");
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    call.write({
      content:
        'Here is the SVG:\n```svg\n<svg viewBox="0 0 200 200"><style>/* Horse Body & Global Bobbing */ rect { fill: red; }</style><rect width="200" height="200"/>',
    });
    const preview = page.getByRole("img", {
      name: "SVG preview",
      exact: true,
      includeHidden: true,
    });
    const color = () =>
      preview.evaluate((el) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 200;
        const context = canvas.getContext("2d")!;
        context.drawImage(el as HTMLImageElement, 0, 0, 200, 200);
        return [...context.getImageData(100, 100, 1, 1).data];
      });
    await expect(preview).toBeVisible();
    await expect.poll(color).toEqual([255, 0, 0, 255]);
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    await expect(preview).toBeHidden();
    call.write({
      reasoning: "Now adding blue.",
      content: '<circle cx="100" cy="100" r="70" fill="blue"/>',
    });
    await expect(trace).toContainText("Now adding blue.");
    await expect.poll(color).toEqual([0, 0, 255, 255]);
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    await expect(preview).toBeVisible();
    await expect.poll(color).toEqual([0, 0, 255, 255]);
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    call.finish();
    await expect(page.locator(".grid-cost")).toHaveAttribute(
      "aria-label",
      "Total cost: $0.01",
    );
    await expect(trace).toContainText("Now adding blue.");
    await page
      .getByRole("button", { name: "Show thinking", exact: true })
      .click();
    const final = page.getByRole("img", { name: "Generated SVG", exact: true });
    await expect(final).toBeVisible();
    await expect
      .poll(() => final.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    const saved = await page.request.get((await final.getAttribute("src"))!);
    expect(await saved.text()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><style>/* Horse Body &amp; Global Bobbing */ rect { fill: red; }</style><rect width="200" height="200"/><circle cx="100" cy="100" r="70" fill="blue"/></svg>',
    );
  } finally {
    await context.close();
    await fixture.close();
  }
});
