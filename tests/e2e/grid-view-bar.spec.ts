import { test, expect } from "./fixtures";
import { createJudged, judgedInput } from "./judged-helpers";
import { connectOpenRouter, selectModel, setVariableValues } from "./helpers";
import { currentInput } from "../current-grid-fixture";
import { runtimeFixture } from "../runtime-fixture";

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

test("completed grids select judgments and global pressed states follow individual cells", async ({
  page,
}) => {
  await page.request.post("/fixture/reset", { data: { costStreaming: true } });
  await createJudged(page);
  const cells = page.locator(".cell");
  const bar = page.getByRole("group", { name: "Grid view", exact: true });
  const judgments = bar.getByRole("button", { name: "Judge results", exact: true });
  const outputs = bar.getByRole("button", { name: "Outputs", exact: true });
  const thinking = bar.getByRole("button", { name: "Thinking", exact: true });
  await expect(cells.last().locator(".judge-result-button")).toHaveAttribute(
    "aria-busy", "false",
  );
  await expect(judgments).toHaveAttribute("aria-pressed", "true");
  await expect(outputs).toHaveAttribute("aria-pressed", "false");
  await expect(thinking).toHaveAttribute("aria-pressed", "false");
  const count = await cells.count();
  for (let index = 0; index < count; index++) {
    await cells.nth(index).locator(".judge-result-button").click();
    await expect(judgments).toHaveAttribute("aria-pressed", "false");
    await expect(outputs).toHaveAttribute("aria-pressed", String(index === count - 1));
    await expect(cells.nth(index).getByRole("heading", { name: "Drawing", exact: true })).toBeVisible();
  }
  for (let index = 0; index < count; index++) {
    await cells.nth(index).getByRole("button", { name: "Show thinking", exact: true }).click();
    await expect(outputs).toHaveAttribute("aria-pressed", "false");
    await expect(thinking).toHaveAttribute("aria-pressed", String(index === count - 1));
  }
  await cells.first().getByRole("button", { name: "View raw", exact: true }).click();
  await expect(thinking).toHaveAttribute("aria-pressed", "false");
  await expect(outputs).toHaveAttribute("aria-pressed", "false");
  for (let index = 0; index < count; index++) {
    await cells.nth(index).locator(".judge-result-button").click();
    await expect(judgments).toHaveAttribute("aria-pressed", String(index === count - 1));
  }
  await page.reload();
  await expect(judgments).toHaveAttribute("aria-pressed", "true");
});

test("judged grids without any thinking omit the Thinking segment and track output versus raw", async ({
  page,
}) => {
  await createJudged(page);
  const cells = page.locator(".cell");
  const bar = page.getByRole("group", { name: "Grid view", exact: true });
  await expect(cells.last().locator(".judge-result-button")).toHaveAttribute(
    "aria-busy", "false",
  );
  await expect(bar.getByRole("button", { name: "Thinking", exact: true })).toHaveCount(0);
  const outputs = bar.getByRole("button", { name: "Outputs", exact: true });
  await outputs.click();
  await expect(outputs).toHaveAttribute("aria-pressed", "true");
  const raw = cells.first().getByRole("button", { name: "View raw", exact: true });
  await raw.click();
  await expect(outputs).toHaveAttribute("aria-pressed", "false");
  await raw.click();
  await expect(outputs).toHaveAttribute("aria-pressed", "true");
});

test("only cells with thinking participate in the Thinking pressed state", async ({
  browser,
}) => {
  const fixture = await runtimeFixture({ workers: 2 });
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: fixture.cookieName, value: fixture.owner, url: fixture.origin },
    ]);
    const response = await fixture.request("/api/grids", currentInput({
      judge: true,
      caseAxes: ["rows"],
      budgetUsd: 0.1,
      parallelWorkers: 2,
      parameters: {
        input: { kind: "common", value: [{ role: "user", content: "Draw $ROW1" }] },
        effort: { kind: "common", value: "none" },
      },
      rows: [
        { variable: [{ text: "with trace" }] },
        { variable: [{ text: "without trace" }] },
      ],
    }));
    expect(response.status).toBe(201);
    const grid = await response.json();
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const cells = page.locator(".cell");
    const bar = page.getByRole("group", { name: "Grid view", exact: true });
    const thinking = bar.getByRole("button", { name: "Thinking", exact: true });
    const judgments = bar.getByRole("button", { name: "Judge results", exact: true });
    const outputs = bar.getByRole("button", { name: "Outputs", exact: true });
    const generators = [await fixture.nextCall(), await fixture.nextCall()];
    const first = generators.find((call) => call.prompt === "Draw with trace")!;
    const second = generators.find((call) => call.prompt === "Draw without trace")!;
    await expect(thinking).toHaveCount(0);
    first.write({ reasoning: "A saved thought." });
    await expect(thinking).toHaveAttribute("aria-pressed", "true");
    first.write({ content: "# With thinking" });
    first.finish();
    second.write({ content: "# Without thinking" });
    second.finish();
    for (let index = 0; index < 2; index++) {
      const judge = await fixture.nextCall();
      expect(judge.request.response_format?.json_schema.name).toBe("judgment");
      judge.write({ content: JSON.stringify({
        results: [{ verdict: true, explanation: "The output meets the criterion." }],
      }) });
      judge.finish();
    }
    await expect(cells.last().locator(".judge-result-button")).toHaveAttribute(
      "aria-busy", "false",
    );
    await expect(judgments).toHaveAttribute("aria-pressed", "true");
    await expect(cells.first().getByRole("button", { name: "Show thinking", exact: true })).toBeVisible();
    await expect(cells.last().getByRole("button", { name: "Show thinking", exact: true })).toHaveCount(0);
    await cells.first().getByRole("button", { name: "Show thinking", exact: true }).click();
    await expect(cells.first().getByRole("region", { name: /^Thinking:/ })).toContainText("A saved thought.");
    await expect(thinking).toHaveAttribute("aria-pressed", "true");
    await expect(judgments).toHaveAttribute("aria-pressed", "false");
    await expect(outputs).toHaveAttribute("aria-pressed", "false");
    await cells.last().getByRole("button", { name: "View raw", exact: true }).click();
    await expect(thinking).toHaveAttribute("aria-pressed", "true");
    await outputs.click();
    await expect(outputs).toHaveAttribute("aria-pressed", "true");
    await thinking.click();
    await expect(thinking).toHaveAttribute("aria-pressed", "true");
    await expect(cells.last().getByRole("heading", { name: "Without thinking", exact: true })).toBeVisible();
    await cells.last().locator(".judge-result-button").click();
    await expect(thinking).toHaveAttribute("aria-pressed", "true");
    await cells.first().getByRole("button", { name: "View raw", exact: true }).click();
    await expect(thinking).toHaveAttribute("aria-pressed", "false");
  } finally {
    await context.close();
    await fixture.close();
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
