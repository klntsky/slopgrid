import { test, expect } from "./fixtures";

test("opening a grid from a scrolled list keeps its header visible in mobile desktop mode", async ({
  browser,
  mockServer,
}) => {
  const context = await browser.newContext({
    baseURL: mockServer,
    ignoreHTTPSErrors: true,
    viewport: { width: 980, height: 600 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.request.post("/fixture/grids", {
      data: { counts: { owned: 20, public: 20 } },
    });
    await page.reload();
    const link = page.locator(".public-grids .history-grid-link").last();
    await link.scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(300);
    const originalScroll = await page.evaluate(() => window.scrollY);
    await link.tap();
    await expect(page.locator(".grid-scroll")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("header")
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      )
      .toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          window: window.scrollY,
          shell: document.querySelector(".app-shell")!.scrollTop,
        })),
      )
      .toEqual({ window: 0, shell: 0 });
    await page.goBack();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(originalScroll);
  } finally {
    await context.close();
  }
});

for (const format of ["SVG", "Image"]) {
  test(`${format} draft restores page scroll on reload and history navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    const prompt = page.getByLabel("Prompt", { exact: true });
    await prompt.fill("Preserved draft");
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
    await page.evaluate(() => new Promise(requestAnimationFrame));

    await page.reload();
    await expect(prompt).toHaveValue("Preserved draft");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);

    // Activate navigation without scrolling the header into view first.
    await page
      .getByRole("link", { name: "SETTINGS", exact: true })
      .evaluate((link: HTMLAnchorElement) => link.click());
    await expect(page).toHaveURL(/\/settings$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect(prompt).toHaveValue("Preserved draft");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
    await page.goForward();
    await expect(page).toHaveURL(/\/settings$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
}
