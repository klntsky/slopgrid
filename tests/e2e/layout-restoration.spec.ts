import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test.describe("touch expansion", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("expanded output keeps the complete navbar visible and uses unscaled controls", async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: { billing: false } });
    await create(page, "SVG", "cat\ndog", "hat\ncape");
    await expectProgress(page, 4, 4);
    const menu = page.getByRole("button", { name: "Navigation menu" });
    await menu.tap();
    await expect(
      page.getByRole("tooltip").filter({ hasText: "Navigation menu" }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "SETTINGS", exact: true }).tap();
    await expect(page).toHaveURL(/\/settings$/);
    await page.goBack();
    await expectProgress(page, 4, 4);
    const before = (await page.locator("article.cell").first().boundingBox())!;
    const header = (await page.getByRole("banner").boundingBox())!;
    await page
      .getByRole("button", { name: "Expand SVG", exact: true })
      .first()
      .click();
    const expanded = page.locator(".cell-expanded");
    await expect
      .poll(async () => (await expanded.boundingBox())!.y)
      .toBeCloseTo(header.y + header.height, 0);
    const collapse = page.getByRole("button", {
      name: "Collapse SVG",
      exact: true,
    });
    expect((await collapse.boundingBox())!.width).toBeCloseTo(36, 0);
    await expect(expanded.locator(".cell-footer")).toHaveCount(0);
    await menu.tap();
    await page
      .getByRole("link", { name: "SETTINGS", exact: true })
      .tap({ trial: true });
    await menu.tap();
    await collapse.click();
    expect(
      (await page.locator("article.cell").first().boundingBox())!.width,
    ).toBeCloseTo(before.width, 0);
  });
});

test("column dragging changes the visible width of a viewport-fitted grid and persists it", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const cell = page.locator("article.cell").first();
  const before = (await cell.boundingBox())!;
  const handle = (await page
    .getByRole("separator", { name: "Resize column 1", exact: true })
    .boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 5);
  await page.mouse.up();
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(before.width + 40, 0);
  await page.reload();
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(before.width + 40, 0);
});
