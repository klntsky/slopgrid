import { test, expect } from "./fixtures";
import { mockModels, selectModel, expectProgress } from "./helpers";

test("budget estimates follow expanded prompts, warn without blocking, and preserve automatic selection", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { balanceUsd: 0.3, holdGenerations: true },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
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
  const workers = page.getByLabel("# of parallel workers:", { exact: true });
  const budget = page.getByLabel("Budget limit per cell", { exact: true });
  const table = page.getByRole("table", { name: "Budget compatibility" });
  await expect(budget).toHaveValue("3");
  await expect(workers).toHaveValue("2");
  await expect(table).toHaveCount(0);
  await budget.fill("0.1");
  await expect(workers).toHaveValue("3");
  await expect(table.locator('[data-support="unsupported"]')).toHaveCount(3);
  const warning = table.locator("td").first();
  await warning.focus();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "$0.1" }),
  ).toBeVisible();
  const amounts = (await warning.getAttribute("data-tooltip"))!.match(
    /\$[\d.]+/g,
  );
  expect(amounts).toEqual(["$0.1", "$0.1275"]);
  await page.getByLabel("Row values").fill(`a\n${"b".repeat(1000)}\nc`);
  await expect(workers).toHaveValue("1");
  await expect(table.locator('[data-support="unknown"]')).toHaveCount(1);
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
