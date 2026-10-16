import { test as base, expect } from "./fixtures";
import { firefox } from "@playwright/test";

const test = base.extend<{ resistFingerprinting: boolean }>({
  resistFingerprinting: [false, { option: true }],
  page: [
    async ({ mockServer, resistFingerprinting }, use) => {
      const browser = await firefox.launch({
        firefoxUserPrefs: {
          "privacy.resistFingerprinting": resistFingerprinting,
        },
      });
      try {
        const page = await browser.newPage({
          baseURL: mockServer,
          ignoreHTTPSErrors: true,
        });
        await use(page);
      } finally {
        await browser.close();
      }
    },
    { timeout: 60000 },
  ],
});

for (const resistFingerprinting of [false, true]) {
  test.describe(`Firefox desktop with fingerprinting resistance ${resistFingerprinting}`, () => {
    test.use({ resistFingerprinting });
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
