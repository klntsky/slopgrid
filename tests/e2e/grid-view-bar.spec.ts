import { test, expect } from "./fixtures";
import { createJudged, judgedInput } from "./judged-helpers";
import { connectOpenRouter, selectModel, setVariableValues } from "./helpers";

test("grid views switch every cell, retain expansion, and allow local overrides", async ({
  page,
}) => {
  await page.request.post("/fixture/reset", {
    data: { costStreaming: true, holdJudges: true },
  });
  await createJudged(page, judgedInput);
  const cells = page.locator(".cell");
  const output = (index: number) =>
    cells.nth(index).getByRole("heading", { name: "Drawing", exact: true });
  const details = (index: number) =>
    cells.nth(index).getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
  await expect(output(0)).toBeVisible();
  const bar = page.getByRole("group", { name: "Grid view", exact: true });
  const outputs = bar.getByRole("button", { name: "Outputs", exact: true });
  const thinking = bar.getByRole("button", { name: "Thinking", exact: true });
  const judgments = bar.getByRole("button", {
    name: "Judge results",
    exact: true,
  });
  await expect(
    bar.getByRole("button", { name: "Benchmark results", exact: true }),
  ).toBeDisabled();
  await thinking.click();
  for (const [index, cell] of (await cells.all()).entries()) {
    await expect(
      cell.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Thinking through the drawing.");
    await expect(output(index)).toBeHidden();
  }
  await cells.first().getByRole("button", {
    name: "View raw",
    exact: true,
  }).click();
  await expect(cells.first().locator(".markdown-raw").first()).toContainText(
    "# Drawing",
  );
  await expect(
    cells.nth(1).getByRole("region", { name: /^Thinking:/ }),
  ).toBeVisible();
  await expect(thinking).toHaveAttribute("aria-pressed", "false");
  await outputs.click();
  for (let index = 0; index < await cells.count(); index++) {
    await expect(output(index)).toBeVisible();
  }
  await cells.first().getByRole("button", {
    name: "Expand Markdown",
    exact: true,
  }).click();
  await judgments.click();
  await expect(
    page.getByRole("region", { name: /^Expanded output:/ }),
  ).toBeVisible();
  await expect(details(0)).toContainText("Judging...");
  await cells.first().getByRole("button", {
    name: "Collapse judgment",
    exact: true,
  }).click();
  await outputs.click();
  await page.request.post("/fixture/release", { data: { all: true } });
  await expect(cells.first().locator(".judge-result-button")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  for (let index = 0; index < await cells.count(); index++) {
    await expect(output(index)).toBeVisible();
  }
  await judgments.click();
  for (let index = 0; index < await cells.count(); index++) {
    await expect(details(index)).toContainText("red rectangle");
  }
  await outputs.click();
  await outputs.click();
  await expect(outputs).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(bar).toBeVisible();
  for (let index = 0; index < await cells.count(); index++) {
    await expect(details(index)).toBeVisible();
  }
});

test("unjudged grids have no grid view bar", async ({ page }) => {
  await page.goto("/create");
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["cat"]);
  await page.getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Columns", ["hat"]);
  await selectModel(page, "fixture/text");
  await page.getByLabel("Prompt", { exact: true })
    .fill("Draw $ROW1 wearing a $COLUMN1");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Grid view", exact: true }),
  ).toHaveCount(0);
});
