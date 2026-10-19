import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  mockModels,
  selectModel,
  expectProgress,
} from "./helpers";

test("budget warnings group models across thinking efforts and axis swaps", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) => ({
      ...model,
      pricing:
        model.id === "fixture/text"
          ? { prompt: 0, completion: 0.01 }
          : undefined,
      contextLength: 10000,
      maxCompletionTokens: 100,
    })),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("model");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  const models = page.getByRole("group", { name: "Row values", exact: true });
  await models.getByRole("searchbox").fill("");
  for (const id of ["fixture/text", "fixture/other"])
    await models.locator(`input[value="${id}"]`).check();
  const efforts = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  for (const effort of ["low", "high"])
    await efforts.getByRole("checkbox", { name: effort, exact: true }).check();
  const budget = page.getByLabel("Budget limit per cell", { exact: true });
  await budget.fill("0.5");
  const warnings = page.locator(".budget-warnings");
  await expect(warnings.locator("p")).toHaveCount(2);
  await expect(warnings.locator("[data-tooltip]")).toHaveCount(1);
  await expect(warnings.locator("[data-tooltip]")).toContainText("$1");
  await expect(warnings).toContainText("Pricing unavailable.");
  const before = await warnings.locator("p").allTextContents();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(warnings.locator("p")).toHaveText(before);
  await budget.fill("2");
  await expect(warnings.locator("p")).toHaveCount(1);
  await expect(warnings.locator("[data-tooltip]")).toHaveCount(0);
  await page
    .getByRole("group", { name: "Column values", exact: true })
    .getByRole("searchbox")
    .fill("");
  await page
    .getByRole("group", { name: "Column values", exact: true })
    .locator('input[value="fixture/other"]')
    .uncheck();
  await expect(warnings).toHaveCount(0);
});

test("budget estimates follow expanded prompts, warn without blocking, and preserve automatic selection", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { balanceUsd: 0.3, holdGenerations: true },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await connectOpenRouter(page);
  await expect(
    page.getByLabel("Budget limit per cell", { exact: true }),
  ).toBeVisible();
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/text"
        ? {
            ...model,
            pricing: { prompt: 0.0001, completion: 0.001 },
            contextLength: 10000,
            maxCompletionTokens: 100,
          }
        : model,
    ),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill("a\nb\nc");
  await page.getByLabel("Column values").fill("d");
  await selectModel(page, "fixture/text");
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW $COLUMN");
  const budget = page.getByLabel("Budget limit per cell", { exact: true });
  const warnings = page.locator(".budget-warnings");
  await expect(warnings).toHaveCount(0);
  await budget.fill("0.1");
  await expect(warnings.locator("p")).toHaveCount(1);
  const warning = warnings.locator("[data-tooltip]").first();
  await expect(warning).toContainText("$0.1275");
  await warning.focus();
  const tooltip = page.getByRole("tooltip").filter({ hasText: "$0.1" });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("$0.1275");
  await page.getByLabel("Row values").fill(`a\n${"b".repeat(100)}\nc`);
  await expect(warning).toContainText("$0.1374");
  await page.getByLabel("Row values").fill(`a\n${"b".repeat(1000)}\nc`);
  await expect(warnings).toContainText("The cell budget is too small");
  await expect(warning).toContainText("$0.1275");
  await page.getByLabel("Row values").fill("a\nb\nc");
  await page.reload();
  await expect(budget).toHaveValue("0.1");
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  expect((await sent).postDataJSON().parallelWorkers).toBeUndefined();
  await expectProgress(page, 0, 3);
  await request.post("/fixture/release", { data: { all: true } });
  await expectProgress(page, 3, 3);
});
