import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  mockModels,
  selectModel,
  expectProgress,
  setVariableValues,
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
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
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
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(warnings.locator("[data-tooltip]")).toHaveCount(1);
  await expect(warnings.locator("[data-tooltip]")).toContainText("$1");
  await expect(warnings).toContainText("Pricing unavailable.");
  const warnedModels = await warnings.locator("strong").allTextContents();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(warnings.locator("strong")).toHaveText(warnedModels);
  await expect(warnings.locator("[data-tooltip]")).toHaveCount(1);
  await expect(warnings.locator("[data-tooltip]")).toContainText("$1");
  await expect(warnings).toContainText("Pricing unavailable.");
  await budget.fill("2");
  await expect(warnings.getByRole("status")).toHaveCount(1);
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

test("chat budget warnings count actual calls once across models and efforts", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) => ({
      ...model,
      pricing:
        model.id === "fixture/text"
          ? { prompt: 0.0001, completion: 0.001 }
          : undefined,
      contextLength: 10000,
      maxCompletionTokens: 100,
    })),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page.getByLabel("Message 1", { exact: true }).fill("a");
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("model");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  const models = page.getByRole("group", { name: "Row values", exact: true });
  await models.getByRole("searchbox").fill("");
  for (const checkbox of await models.locator("input:checked").all())
    await checkbox.uncheck();
  for (const id of ["fixture/text", "fixture/other"])
    await models.locator(`input[value="${id}"]`).check();
  const efforts = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  for (const checkbox of await efforts.locator("input:checked").all())
    await checkbox.uncheck();
  for (const effort of ["low", "high"])
    await efforts.getByRole("checkbox", { name: effort, exact: true }).check();
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.1");
  const warnings = page.locator(".budget-warnings");
  const pipeline = warnings.getByRole("status").filter({
    hasText: /Inference will run \d+ times\./,
  });
  const missingPricing = warnings
    .getByRole("status")
    .filter({ hasText: "Pricing unavailable." });
  const reduction = warnings.locator("[data-tooltip]");
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(pipeline).toHaveCount(0);
  await expect(reduction).toHaveCount(1);
  await expect(reduction).toContainText("$0.1263");
  await expect(missingPricing).toHaveCount(1);
  await expect(missingPricing.locator("strong")).toHaveCount(1);
  const unpricedModel = await missingPricing.locator("strong").innerText();

  async function appendMessage() {
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
  }
  async function removeMessage(index: number) {
    const remove = page.getByRole("button", {
      name: `Remove message ${index}`,
      exact: true,
    });
    await remove.focus();
    await remove.press("Enter");
    await expect(page.locator(".chat-message")).toHaveCount(index - 1);
  }
  async function expectPipeline(calls: number) {
    await expect(pipeline).toHaveCount(1);
    await expect(pipeline).toContainText(`${calls} "unfilled"`);
    await expect(pipeline).toContainText(`Inference will run ${calls} times.`);
    await expect(warnings.getByRole("status")).toHaveCount(2);
    await expect(reduction).toHaveCount(0);
    await expect(missingPricing.locator("strong")).toHaveText(unpricedModel);
    await expect(warnings.locator('[data-estimate="unknown"]')).toHaveCount(1);
  }

  await appendMessage();
  await expect(
    page.getByRole("button", { name: "Message 2 role: unfilled", exact: true }),
  ).toBeVisible();
  await expect(pipeline).toHaveCount(0);
  await expect(reduction).toContainText("$0.1263");
  await appendMessage();
  await page.getByLabel("Message 3", { exact: true }).fill("Follow up");
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(1);
  await expectPipeline(2);
  await appendMessage();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
  await expectPipeline(2);
  await appendMessage();
  await page.getByLabel("Message 5", { exact: true }).fill("One more");
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(2);
  await expectPipeline(3);
  await removeMessage(5);
  await expectPipeline(2);
  await removeMessage(4);
  await expectPipeline(2);
  await removeMessage(3);
  await expect(pipeline).toHaveCount(0);
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(reduction).toContainText("$0.1263");
  await removeMessage(2);
  await expect(pipeline).toHaveCount(0);
  await expect(reduction).toContainText("$0.1263");
  await expect(missingPricing.locator("strong")).toHaveText(unpricedModel);
});

test("chat budget reductions use the highest expanded history cost per model", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) => ({
      ...model,
      pricing: {
        prompt: 0.0001,
        completion: model.id === "fixture/other" ? 0.002 : 0.001,
      },
      contextLength: 10000,
      maxCompletionTokens: 100,
    })),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  const models = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await models.getByRole("searchbox").fill("");
  for (const checkbox of await models.locator("input:checked").all())
    await checkbox.uncheck();
  for (const id of ["fixture/text", "fixture/other"])
    await models.locator(`input[value="${id}"]`).check();
  await setVariableValues(page, "Rows", ["a", "b".repeat(100), "c"]);
  await page.getByLabel("Message 1", { exact: true }).fill("$ROW1");
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("button", { name: "Message 2 role: unfilled", exact: true })
    .click();
  await page.getByLabel("Message 2", { exact: true }).fill("$ROW1");
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.1");
  const warnings = page.locator(".budget-warnings");
  const reductions = warnings.locator("[data-tooltip]");
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(reductions).toHaveCount(2);
  await expect(warnings.locator('[data-estimate="unknown"]')).toHaveCount(0);
  await expect(reductions.filter({ hasText: "$0.1472" })).toHaveCount(1);
  await expect(reductions.filter({ hasText: "$0.2472" })).toHaveCount(1);
  const warnedModels = await warnings.locator("strong").allTextContents();
  await setVariableValues(page, "Rows", ["a", "b".repeat(200), "c"]);
  await expect(reductions.filter({ hasText: "$0.1672" })).toHaveCount(1);
  await expect(reductions.filter({ hasText: "$0.2672" })).toHaveCount(1);
  await expect(warnings.locator("strong")).toHaveText(warnedModels);
  await setVariableValues(page, "Rows", ["a", "b", "c"]);
  await expect(reductions.filter({ hasText: "$0.1274" })).toHaveCount(1);
  await expect(reductions.filter({ hasText: "$0.2274" })).toHaveCount(1);
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("button", { name: "Message 3 role: user", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Message 3 role: assistant", exact: true })
    .click();
  await expect(page.locator(".chat-role-unfilled")).toHaveCount(1);
  await expect(warnings.getByRole("status")).toHaveCount(2);
  await expect(reductions.filter({ hasText: "$0.1274" })).toHaveCount(1);
  await expect(reductions.filter({ hasText: "$0.2274" })).toHaveCount(1);
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
    .selectOption("effort");
  await setVariableValues(page, "Rows", ["a", "b", "c"]);
  await selectModel(page, "fixture/text");
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW1 d");
  const budget = page.getByLabel("Budget limit per cell", { exact: true });
  const warnings = page.locator(".budget-warnings");
  await expect(warnings).toHaveCount(0);
  await budget.fill("0.1");
  await expect(warnings.getByRole("status")).toHaveCount(1);
  const warning = warnings.locator("[data-tooltip]");
  await expect(warning).toContainText("$0.1275");
  await warning.focus();
  const tooltip = page.getByRole("tooltip").filter({ hasText: "$0.1" });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("$0.1275");
  await setVariableValues(page, "Rows", ["a", "b".repeat(100), "c"]);
  await expect(warning).toContainText("$0.1374");
  await setVariableValues(page, "Rows", ["a", "b".repeat(1000), "c"]);
  await expect(warnings).toContainText("The cell budget is too small");
  await expect(warning).toContainText("$0.1275");
  await setVariableValues(page, "Rows", ["a", "b", "c"]);
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
