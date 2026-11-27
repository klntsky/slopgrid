import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

for (const format of ["Markdown", "Static website"]) {
  test(`${format} expanded arrows follow grid coordinates and restore focus`, async ({
    page,
  }) => {
    await create(page, {
      format,
      columns: { kind: "effort", values: ["default", "low"] },
    });
    await expectProgress(page, 4, 4);
    const cells = page.locator(".output-grid td");
    const expanded = page.getByRole("region", { name: /^Expanded output:/ });
    const expectCell = async (index: number) => {
      await expect(
        cells.nth(index).getByRole("region", { name: /^Expanded output:/ }),
      ).toBeVisible();
      await expect(
        expanded.getByRole("button", { name: `Collapse ${format}`, exact: true }),
      ).toBeFocused();
    };
    await cells
      .nth(0)
      .getByRole("button", { name: `Expand ${format}`, exact: true })
      .click();
    await expectCell(0);
    for (const key of [
      "ArrowLeft",
      "ArrowUp",
      "Alt+ArrowRight",
      "Shift+ArrowDown",
    ])
      await page.keyboard.press(key);
    await expectCell(0);
    await page.keyboard.press("ArrowRight");
    await expectCell(1);
    await page.keyboard.press("ArrowRight");
    await expectCell(1);
    await page.keyboard.press("ArrowDown");
    await expectCell(3);
    await page.keyboard.press("ArrowDown");
    await expectCell(3);
    await page.keyboard.press("ArrowLeft");
    await expectCell(2);
    await page.keyboard.press("ArrowUp");
    await expectCell(0);
    await page.keyboard.press("ArrowRight");
    await expectCell(1);
    await page.keyboard.press("Escape");
    await expect(expanded).toHaveCount(0);
    await expect(
      cells.nth(1).getByRole("button", { name: `Expand ${format}`, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(expanded).toHaveCount(0);
  });
}

test("website arrows navigate from preview content without taking editing keys or reloading previews", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: {
      websiteOutput:
        '<!doctype html><h1>Keyboard preview</h1><label>Note <input></label><label>Choice <select><option>First</option><option>Second</option></select></label><p contenteditable="true" aria-label="Editable note">Editable text</p>',
    },
  });
  await create(page, { format: "Static website" });
  await expectProgress(page, 2, 2);
  const cells = page.locator(".output-grid td");
  await cells
    .nth(0)
    .getByRole("button", { name: "Expand Static website", exact: true })
    .click();
  const first = cells.nth(0).frameLocator('iframe[aria-hidden="false"]');
  const note = first.getByRole("textbox", { name: "Note", exact: true });
  await note.fill("saved note");
  await note.press("ArrowDown");
  await expect(cells.nth(0).getByRole("region")).toBeVisible();
  const choice = first.getByRole("combobox", { name: "Choice" });
  await choice.focus();
  await choice.press("ArrowDown");
  await expect(choice).toHaveValue("Second");
  await expect(cells.nth(0).getByRole("region")).toBeVisible();
  const editable = first.getByLabel("Editable note");
  await editable.fill("saved editable text");
  await editable.press("ArrowDown");
  await expect(cells.nth(0).getByRole("region")).toBeVisible();
  await first.getByRole("heading", { name: "Keyboard preview" }).click();
  await page.keyboard.press("ArrowDown");
  await expect(cells.nth(1).getByRole("region")).toBeVisible();
  await cells
    .nth(1)
    .frameLocator('iframe[aria-hidden="false"]')
    .getByRole("heading", { name: "Keyboard preview" })
    .click();
  await page.keyboard.press("ArrowUp");
  await expect(cells.nth(0).getByRole("region")).toBeVisible();
  await expect(note).toHaveValue("saved note");
  await expect(editable).toHaveText("saved editable text");
  await note.press("Escape");
  await expect(
    page.getByRole("region", { name: /^Expanded output:/ }),
  ).toHaveCount(0);
});
