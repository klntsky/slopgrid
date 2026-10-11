import { expect } from "@playwright/test";

export async function finishPublishing(page: import("@playwright/test").Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Accessible by link" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function expectProgress(
  page: import("@playwright/test").Page,
  finished: number,
  total: number,
) {
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("value", String(finished));
  await expect(bar).toHaveAttribute("max", String(total));
}

export async function create(
  page: import("@playwright/test").Page,
  format = "SVG",
  rows = "cat\ndog",
  columns = "hat",
  prompt = "Draw $ROW wearing a $COLUMN",
  model?: string,
) {
  await page.goto("/");
  await page.getByRole("button", { name: format, exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill(rows);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values").fill(columns);
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption(
      model ?? (format === "Image" ? "fixture/image" : "fixture/text"),
    );
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}
