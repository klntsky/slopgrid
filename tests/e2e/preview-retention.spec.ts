import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

for (const touch of [false, true]) {
  test.describe(touch ? "phone" : "desktop", () => {
    test.use({
      viewport: { width: touch ? 390 : 1280, height: 844 },
      hasTouch: touch,
      isMobile: touch,
    });
    test("expansion retains the website browsing context and restores focus", async ({
      page,
    }) => {
      await create(page, "Static website", "cat", "hat");
      await expectProgress(page, 1, 1);
      const frame = page.frameLocator('iframe[aria-hidden="false"]');
      await expect(frame.locator("body")).toBeVisible();
      const original = await page
        .locator('iframe[aria-hidden="false"]')
        .elementHandle();
      await frame.locator("body").evaluate((body) => {
        body.dataset.retained = "website-session";
      });
      const expand = page.getByRole("button", {
        name: "Expand Static website",
        exact: true,
      });
      await expand.click();
      const region = page.getByRole("region", { name: /^Expanded output:/ });
      await expect(
        region.frameLocator('iframe[aria-hidden="false"]').locator("body"),
      ).toHaveAttribute("data-retained", "website-session");
      expect(
        await region
          .locator('iframe[aria-hidden="false"]')
          .evaluate((node, saved) => node === saved, original),
      ).toBe(true);
      await page
        .getByRole("button", { name: "Collapse Static website", exact: true })
        .click();
      await expect(frame.locator("body")).toHaveAttribute(
        "data-retained",
        "website-session",
      );
      await expect(expand).toBeFocused();
    });
  });
}
