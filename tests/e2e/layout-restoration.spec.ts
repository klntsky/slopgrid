import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("column dragging changes the visible width of a viewport-fitted grid and persists it", async ({ page, request }) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const cell = page.locator("article.cell").first();
  const before = (await cell.boundingBox())!;
  const handle = (await page.getByRole("separator", { name: "Resize column 1", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 5);
  await page.mouse.up();
  await expect.poll(async () => (await cell.boundingBox())!.width).toBeCloseTo(before.width + 40, 0);
  await page.reload();
  await expect.poll(async () => (await cell.boundingBox())!.width).toBeCloseTo(before.width + 40, 0);
});

test("title edits commit on blur and cancel with Escape without saving", async ({ page, request }) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  await page.getByRole("button", { name: "Set Title", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Grid title" });
  await input.fill("Retained title");
  await input.press("Enter");
  const edit = page.getByRole("button", { name: "Edit title", exact: true });
  await expect(edit).toHaveText("Retained title");
  await edit.click();
  await input.fill("Cancelled title");
  await input.press("Escape");
  await expect(edit).toBeFocused();
  await page.reload();
  await expect(edit).toHaveText("Retained title");
  await edit.click();
  await input.fill("Blur title");
  await input.press("Tab");
  await expect(edit).toHaveText("Blur title");
});
