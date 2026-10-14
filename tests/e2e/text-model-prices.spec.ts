import { test, expect } from "./fixtures";
import { mockModels } from "./helpers";

test("text model prices convert token rates and retain free and missing pricing across selectors", async ({
  page,
}) => {
  await mockModels(page, (models) => {
    const model = models.find((m) => m.id === "fixture/text")!;
    return [
      {
        ...model,
        pricing: { prompt: 0.000003, completion: 0.00002, request: 0.001 },
      },
      {
        ...model,
        id: "fixture/free",
        name: "Free model",
        pricing: { prompt: 0, completion: 0 },
      },
      {
        ...model,
        id: "fixture/unpriced",
        name: "Unpriced model",
        pricing: undefined,
      },
    ];
  });
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page.getByLabel("Search models").fill("");
  const price = (name: string) =>
    page
      .locator("label.checkbox")
      .filter({ has: page.getByRole("checkbox", { name, exact: true }) })
      .locator(".model-price");
  await expect(price("Fixture text")).toContainText("$3.00 in / $20.00 out");
  await expect(price("Free model")).toContainText("$0.00 in / $0.00 out");
  await expect(price("Unpriced model")).toHaveText("Price unavailable");
  await price("Fixture text").hover();
  const tooltip = page.getByRole("tooltip").filter({ hasText: "Input:" });
  await expect(tooltip).toContainText("Input: $3.00/1M tokens");
  await expect(tooltip).toContainText("Output: $20.00/1M tokens");
  await expect(tooltip).toContainText("Request: $0.001/request");
  const model = page.getByRole("checkbox", {
    name: "Fixture text",
    exact: true,
  });
  await expect(model).not.toBeChecked();
  await model.check();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page.getByLabel("Search models").fill("");
  await expect(model).toBeChecked();
  await expect(price("Fixture text")).toContainText("$3.00 in / $20.00 out");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Search models").fill("");
  const fixedPrice = page
    .locator("label.checkbox")
    .filter({
      has: page.getByRole("radio", { name: "Fixture text", exact: true }),
    })
    .locator(".model-price");
  await expect(fixedPrice).toContainText("$3.00 in / $20.00 out");
  await fixedPrice.focus();
  await expect(tooltip).toContainText("Request: $0.001/request");
});
