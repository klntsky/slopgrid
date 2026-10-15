import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

for (const format of ["SVG", "Image", "Markdown", "Static website"]) {
  test(`${format} phone menu paints above the entire grid and expanded preview`, async ({
    page,
  }) => {
    await create(page, format, "cat\ndog", "hat\ncape");
    await expectProgress(page, 4, 4);
    for (const expanded of [false, true]) {
      if (expanded)
        await page
          .getByRole("button", { name: `Expand ${format}`, exact: true })
          .last()
          .tap();
      if (expanded) {
        const preview = page.getByRole("region", { name: /^Expanded output:/ });
        expect(
          await preview.evaluate((node) => {
            const r = node.getBoundingClientRect();
            for (let y = r.top + 5; y < innerHeight - 5; y += 25) {
              for (let x = 5; x < innerWidth - 5; x += 25) {
                if (!node.contains(document.elementFromPoint(x, y)))
                  return false;
              }
            }
            return true;
          }),
        ).toBe(true);
      }
      await page.getByRole("button", { name: "Navigation menu" }).tap();
      const menu = page.locator('nav[data-open="true"]');
      await expect(menu).toBeVisible();
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      // Sample the whole popup, including padding and the progress-bar crossing.
      const covered = await menu.evaluate((node) => {
        const r = node.getBoundingClientRect(),
          result: string[] = [];
        for (let y = Math.ceil(r.top) + 2; y < r.bottom - 2; y++) {
          for (const x of [r.left + 5, r.left + r.width / 2, r.right - 5]) {
            const top = document.elementFromPoint(x, y);
            if (top && !node.contains(top))
              result.push(`${x},${y}: ${top.className}`);
          }
        }
        return [...new Set(result)];
      });
      expect(covered).toEqual([]);
      await page.getByRole("button", { name: "Navigation menu" }).tap();
    }
  });
}
