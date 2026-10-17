import { test, expect } from "./fixtures";

test("judge criteria preserve boolean answers and judge axes restore fixed settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("button", { name: "[ add a judge ]", exact: true }).click();
  await page.getByLabel("Criterion 1", { exact: true }).fill("Is there a blue circle?");
  await page.getByLabel("Correct answer", { exact: true }).selectOption("false");
  await page.reload();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("Is there a blue circle?");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue("false");
  await page.getByRole("button", { name: "Add criterion", exact: true }).click();
  await expect(page.getByLabel("Correct answer", { exact: true }).nth(1)).toHaveValue("true");
  await page.getByRole("button", { name: "Remove criterion 2", exact: true }).click();
  await page.getByRole("button", { name: "Remove criterion 1", exact: true }).click();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue("true");
  await page.getByRole("combobox", { name: "Rows", exact: true }).selectOption("judge_effort");
  await page.getByRole("combobox", { name: "Columns", exact: true }).selectOption("judge_model");
  await expect(page.getByRole("searchbox", { name: "Search judge models" })).toBeVisible();
  await page.getByRole("button", { name: "Swap rows and columns", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Rows", exact: true })).toHaveValue("judge_model");
  await expect(page.getByRole("combobox", { name: "Columns", exact: true })).toHaveValue("judge_effort");
  await page.getByRole("button", { name: "Remove judge", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Rows", exact: true })).toHaveValue("effort");
  await expect(page.getByRole("combobox", { name: "Columns", exact: true })).toHaveValue("model");
  await expect(page.getByRole("button", { name: "[ add a judge ]", exact: true })).toBeVisible();
});
