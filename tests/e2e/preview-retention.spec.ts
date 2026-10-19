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
      await frame.locator("body").evaluate((body) => {
        body.insertAdjacentHTML(
          "beforeend",
          "<label>Preview note <input></label>",
        );
      });
      await frame
        .getByRole("textbox", { name: "Preview note" })
        .fill("website-session");
      const expand = page.getByRole("button", {
        name: "Expand Static website",
        exact: true,
      });
      await expand.click();
      const region = page.getByRole("region", { name: /^Expanded output:/ });
      await expect(
        region
          .frameLocator('iframe[aria-hidden="false"]')
          .getByRole("textbox", { name: "Preview note" }),
      ).toHaveValue("website-session");
      await page
        .getByRole("button", { name: "Collapse Static website", exact: true })
        .click();
      await expect(
        frame.getByRole("textbox", { name: "Preview note" }),
      ).toHaveValue("website-session");
      await expect(expand).toBeFocused();
    });
  });
}
