import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("Markdown output tabs inherit the current resolved theme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await create(page, "Markdown", "cat", "hat");
  await expectProgress(page, 1, 1);
  for (const theme of ["dark", "light"]) {
    const opened = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Open output", exact: true }).click();
    const output = await opened;
    await output.waitForLoadState();
    await expect
      .poll(() =>
        output
          .locator("html")
          .evaluate((node) => getComputedStyle(node).colorScheme),
      )
      .toBe(theme);
    await output.close();
    if (theme === "dark")
      await page.getByRole("button", { name: "Switch to light theme" }).click();
  }
});
