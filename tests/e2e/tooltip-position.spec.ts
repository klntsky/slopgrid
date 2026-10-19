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
  await expect
    .poll(() =>
      hint.evaluate(
        (node) =>
          new Promise<number>((resolve) => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect();
              resolve(entry.intersectionRatio);
            });
            observer.observe(node);
          }),
      ),
    )
    .toBeGreaterThanOrEqual(0.99);
  await expand.press("Escape");
  await expect(hint).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expand.blur();
  await expand.hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toHaveCount(0);
});
