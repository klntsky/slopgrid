import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("clipboard pending and failed writes recover without duplicate writes", async ({
  page,
}) => {
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((resolve, reject) => {
            Object.assign(window, { finishCopy: resolve, failCopy: reject });
          }),
      },
    });
  });
  const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
  await copy.click();
  await expect(copy).toBeDisabled();
  await page.evaluate(() => (window as any).failCopy(new Error("denied")));
  await expect(copy).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Copy failed" }),
  ).toBeVisible();
  await copy.click();
  await page.evaluate(() => (window as any).finishCopy());
  await expect(
    page.getByRole("status").filter({ hasText: "Copied" }),
  ).toBeVisible();
});
