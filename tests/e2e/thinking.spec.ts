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
      { name: "slopgrid", value: fixture.owner, url: fixture.origin },
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
    await expect.poll(top).toBeGreaterThan(200);
    await expect.poll(bottomGap).toBeLessThanOrEqual(2);
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
      .getByRole("button", { name: "Show output", exact: true })
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
    expect(fixture.calls).toHaveLength(1);
  } finally {
    await context.close();
    await fixture.close();
  }
});
