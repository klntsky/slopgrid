import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  selectModel,
  setVariableValues,
} from "./helpers";

async function rename(page: Page, kind: string, value: string) {
  await page
    .getByRole("button", { name: `Rename ${kind}`, exact: true })
    .click();
  const label = `${kind[0].toUpperCase()}${kind.slice(1)} name`;
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

test("renamed variables preserve generation and named cases override headers through reload and Edit", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["cat", "dog"]);
  await setVariableValues(page, "Columns", ["hat"]);
  await selectModel(page, "fixture/text");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.fill("Draw $ROW1 wearing a $COLUMN1");
  await rename(page, "row variable 1", "animal_2");
  await rename(page, "column variable 1", "ITEM");
  await expect(prompt).toHaveValue("Draw $ANIMAL_2 wearing a $ITEM");
  await rename(page, "row case 1", "Feline");
  await rename(page, "column case 1", "Headwear");
  await page
    .getByRole("button", { name: "Rename row variable 1", exact: true })
    .click();
  const variableName = page.getByRole("textbox", {
    name: "Row variable 1 name",
    exact: true,
  });
  for (const invalidName of ["bad-name", "\u00df", "A B", "ITEM"]) {
    await variableName.fill(invalidName);
    await variableName.press("Enter");
    await expect(variableName).toBeVisible();
    await expect(prompt).toHaveValue("Draw $ANIMAL_2 wearing a $ITEM");
  }
  await variableName.press("Escape");
  await expect(variableName).toHaveCount(0);
  await page.reload();
  await expect(prompt).toHaveValue("Draw $ANIMAL_2 wearing a $ITEM");
  await expect(
    page.getByLabel("$ANIMAL_2, case 1", { exact: true }),
  ).toHaveValue("cat");
  await expect(
    page.getByLabel("$ANIMAL_2, case 2", { exact: true }),
  ).toHaveValue("dog");
  await expect(
    page.getByRole("button", { name: "Rename row case 1", exact: true }),
  ).toHaveText("Feline");
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  const grid = page.locator(".output-grid");
  await expect(grid.locator('tbody th[scope="row"]').nth(0)).toHaveText(
    "Feline",
  );
  await expect(grid.locator('tbody th[scope="row"]').nth(1)).toContainText(
    "$ANIMAL_2: dog",
  );
  await expect(grid.locator("thead th").nth(1)).toHaveText("Headwear");
  await expect(
    page.getByRole("img", { name: "Generated SVG", exact: true }),
  ).toHaveCount(2);
  const calls = await (await request.get("/fixture/calls")).json();
  expect(JSON.stringify(calls)).toContain("Draw cat wearing a hat");
  expect(JSON.stringify(calls)).toContain("Draw dog wearing a hat");
  await page.reload();
  await expect(grid.locator('tbody th[scope="row"]').nth(0)).toHaveText(
    "Feline",
  );
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(prompt).toHaveValue("Draw $ANIMAL_2 wearing a $ITEM");
  await rename(page, "row case 1", "");
  await expect(
    page.getByRole("button", { name: "Rename row case 1", exact: true }),
  ).toHaveText("Case 1");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Rename row case 1", exact: true }),
  ).toHaveText("Case 1");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  await expect(grid.locator('tbody th[scope="row"]').nth(0)).toContainText(
    "$ANIMAL_2: cat",
  );
  await expect(grid.locator("thead th").nth(1)).toHaveText("Headwear");
});
