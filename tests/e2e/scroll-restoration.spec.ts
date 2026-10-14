import { test, expect } from "./fixtures";

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
    await page.getByRole("link", { name: "SETTINGS", exact: true }).evaluate(
      (link: HTMLAnchorElement) => link.click(),
    );
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
