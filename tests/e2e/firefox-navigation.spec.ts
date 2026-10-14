import { test, expect } from "./fixtures";
import { firefox } from "@playwright/test";

for (const resistFingerprinting of [false, true]) {
  test(`Firefox desktop navigation with fingerprinting resistance ${resistFingerprinting}`, async ({
    mockServer,
  }) => {
    const browser = await firefox.launch({
      firefoxUserPrefs: {
        "privacy.resistFingerprinting": resistFingerprinting,
      },
    });
    try {
      const page = await browser.newPage({ baseURL: mockServer });
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
    } finally {
      await browser.close();
    }
  });
}
