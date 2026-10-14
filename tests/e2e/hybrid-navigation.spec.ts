import { test, expect } from "./fixtures";

test("mouse-primary desktop keeps inline navigation when secondary touch is reported", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "maxTouchPoints", { value: 10 });
    const match = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      match(query === "(any-pointer: coarse)" ? "(min-width: 0px)" : query);
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator(".navigation-menu-toggle")).toHaveCount(0);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "SETTINGS", exact: true })
      .click();
    await expect(page).toHaveURL("/settings");
    await page.reload();
    await expect(page.locator(".navigation-menu-toggle")).toHaveCount(0);
    await expect(page.getByRole("navigation")).toBeVisible();
  }
});
