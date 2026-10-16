import { test, expect } from "./fixtures";

for (const resistFingerprinting of [false, true]) {
  test.describe(`Firefox desktop with fingerprinting resistance ${resistFingerprinting}`, () => {
    test.use({
      browserName: "firefox",
      launchOptions: {
        firefoxUserPrefs: {
          "privacy.resistFingerprinting": resistFingerprinting,
        },
      },
    });
    test("navigation and reload preserve mouse controls", async ({ page }) => {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/");
        await expect(page.locator(".navigation-menu-toggle")).toHaveCount(0);
        const nav = page.getByRole("navigation");
        await expect(nav).toBeVisible();
        await nav.getByRole("link", { name: "SETTINGS", exact: true }).click();
        await expect(page).toHaveURL("/settings");
        await page.reload();
        await expect(page.locator(".navigation-menu-toggle")).toHaveCount(0);
        await expect(nav).toBeVisible();
      }
    });
  });
}
