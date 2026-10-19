import { test, expect } from "./fixtures";

for (const mode of ["animated", "reduced", "unsupported"]) {
  test(`theme switching preserves preferences with ${mode} transitions`, async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
    });
    if (mode === "unsupported") {
      await page.addInitScript(() =>
        Object.defineProperty(document, "startViewTransition", {
          value: undefined,
        }),
      );
    }
    await page.goto("/settings");
    const root = page.locator("html");
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(root).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("combobox", { name: "Theme", exact: true })
      .selectOption("light");
    await expect(root).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByRole("combobox", { name: "Theme", exact: true }),
    ).toHaveValue("light");
  });
}
