import { test, expect } from "./fixtures";
import { seedJudged } from "./judged-helpers";

test.use({ browserName: "firefox" });

for (const scenario of ["short", "overflowing", "bottom"] as const) {
  test(`judgment wheel routing with ${scenario} results`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: [
            {
              verdict: false,
              explanation:
                scenario === "short"
                  ? "No blue circle."
                  : "Long explanation. ".repeat(500),
            },
            { verdict: true, explanation: "A red rectangle." },
          ],
        }),
      },
    });
    await seedJudged(page);
    const results = page
      .getByRole("region", { name: "Judgment details", exact: true })
      .first();
    await expect(results).toBeVisible();
    const viewport = page.locator(".grid-scroll");
    await viewport.evaluate((element) => {
      element.style.height = "300px";
    });
    await results.evaluate((element) => {
      element.style.height = "180px";
    });
    expect(
      await results.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(scenario !== "short");
    if (scenario === "bottom") {
      await results.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    }
    await results.hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, 100);
    if (scenario === "overflowing") {
      await expect
        .poll(() => results.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
    } else {
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }
  });
}
