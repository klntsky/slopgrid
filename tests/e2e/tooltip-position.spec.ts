import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("tooltips escape clipped cells and remain in the viewport on keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 600 });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const expand = page.getByRole("button", { name: "Expand SVG", exact: true });
  await expand.focus();
  const hint = page.getByRole("tooltip");
  await expect(hint).toBeVisible();
  expect(
    await hint.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.top >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        !node.closest(".cell")
      );
    }),
  ).toBe(true);
  await expand.press("Escape");
  await expect(hint).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expand.blur();
  await expand.hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toHaveCount(0);
});
