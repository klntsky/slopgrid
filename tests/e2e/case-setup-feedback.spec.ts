import { test, expect } from "./fixtures";

for (const orientation of ["Rows", "Columns"] as const) {
  for (const repair of ["variable", "parameter"] as const) {
    test(`${orientation} empty cases keep setup feedback beside the table and clear it after adding a ${repair}`, async ({
      page,
    }) => {
      await page.goto("/create");
      await page.getByRole("button", { name: "SVG", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Columns", exact: true })
        .selectOption("single");
      await page
        .getByRole("combobox", { name: "Rows", exact: true })
        .selectOption("single");
      await page
        .getByRole("searchbox", { name: "Search models", exact: true })
        .fill("fixture/text");
      await page.locator('input[type="radio"][value="fixture/text"]').check();
      await page
        .getByRole("textbox", { name: "Prompt", exact: true })
        .fill(
          repair === "variable"
            ? `Draw $${orientation === "Rows" ? "ROW" : "COLUMN"}1`
            : "Draw a cat",
        );
      await page
        .getByRole("combobox", { name: orientation, exact: true })
        .selectOption("variable");
      const layout = page
        .getByRole("heading", { name: /^Specify grid layout/ })
        .locator("xpath=ancestor::section[1]");
      const cases = page.locator(".case-layout-section");
      await expect(layout.getByRole("alert")).toHaveCount(0);
      await expect(cases.getByRole("alert")).toHaveCount(1);
      if (repair === "variable") {
        await cases
          .getByRole("button", { name: "new variable", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", {
            name: `$${orientation === "Rows" ? "ROW" : "COLUMN"}1, case 1`,
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await page
          .getByRole("button", {
            name: "define multiple cases for model",
            exact: true,
          })
          .click();
        await expect(
          cases.getByRole("searchbox", { name: "Search models", exact: true }),
        ).toBeVisible();
      }
      await expect(cases.getByRole("alert")).toHaveCount(0);
      await expect(layout.getByRole("alert")).toHaveCount(0);
    });
  }
}
