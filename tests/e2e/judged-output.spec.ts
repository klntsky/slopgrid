import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";
import { finishPublishing, mockModels, selectModel } from "./helpers";

test("judge criteria preserve boolean answers and judge axes restore fixed settings", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const fixedJudge = page.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await fixedJudge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(fixedJudge.getByRole("radio", { checked: true })).toHaveCount(0);
  await page
    .getByLabel("Criterion 1", { exact: true })
    .fill("Is there a blue circle?");
  await page
    .getByLabel("Correct answer", { exact: true })
    .selectOption("false");
  await page.reload();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
    "Is there a blue circle?",
  );
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "false",
  );
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await expect(
    page.getByLabel("Correct answer", { exact: true }).nth(1),
  ).toHaveValue("true");
  await page.getByLabel("Criterion 2", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await page.getByLabel("Criterion 1", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove criterion 1", exact: true })
    .click();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "true",
  );
  await fixedJudge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture/other");
  await fixedJudge
    .locator('input[type="radio"][value="fixture/other"]')
    .check();
  await page
    .getByLabel("Judge thinking effort", { exact: true })
    .selectOption("high");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("judge_effort");
  await expect(
    page
      .getByRole("group", { name: "Row values", exact: true })
      .getByRole("checkbox", { name: "high", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("judge_model");
  await expect(
    page.getByRole("searchbox", { name: "Search judge models" }),
  ).toBeVisible();
  const rowValues = page.getByRole("group", {
    name: "Row values",
    exact: true,
  });
  const columnValues = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await columnValues
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture");
  await expect(
    columnValues.locator('input[type="checkbox"][value="fixture/other"]'),
  ).toBeChecked();
  await columnValues
    .locator('input[type="checkbox"][value="fixture/text"]')
    .check();
  await rowValues.getByRole("checkbox", { name: "None", exact: true }).check();
  await expect(
    page.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("judge_model");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("judge_effort");
  await rowValues
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture");
  await expect(
    rowValues.locator('input[type="checkbox"][value="fixture/other"]'),
  ).toBeChecked();
  await expect(
    rowValues.locator('input[type="checkbox"][value="fixture/text"]'),
  ).toBeChecked();
  await expect(
    columnValues.getByRole("checkbox", { name: "None", exact: true }),
  ).toBeChecked();
  await expect(
    columnValues.getByRole("checkbox", { name: "high", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await fixedJudge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture");
  await expect(
    fixedJudge.locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("none");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("judge_model");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("judge_effort");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .uncheck();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("effort");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("model");
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).not.toBeChecked();
});

test("the judge heading toggles judging without shifting its viewport position", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const checkbox = page.getByRole("checkbox", {
    name: "Add a LLM judge",
    exact: true,
  });
  const heading = page.getByText("Add a LLM judge · evaluates the output", {
    exact: true,
  });
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await checkbox.evaluate((element) =>
      element.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    const before = (await checkbox.boundingBox())!.y;
    await heading.click();
    await expect(checkbox).toBeChecked();
    await expect(
      page.getByRole("radiogroup", { name: "Judge model", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => Math.abs((await checkbox.boundingBox())!.y - before))
      .toBeLessThan(1);
    await checkbox.uncheck();
    await expect(
      page.getByRole("radiogroup", { name: "Judge model", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await checkbox.boundingBox())!.y - before))
      .toBeLessThan(1);
  }
});

test("criterion deletion uses confirmation boundaries and permits an empty table", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const enabled = page.getByRole("checkbox", {
    name: "Add a LLM judge",
    exact: true,
  });
  await enabled.check();
  const first = page.getByLabel("Criterion 1", { exact: true });
  const remove = page.getByRole("button", {
    name: "Remove criterion 1",
    exact: true,
  });
  const confirm = page.getByRole("button", { name: "Delete", exact: true });
  await first.fill("one two three four five six");
  await page
    .getByLabel("Correct answer", { exact: true })
    .selectOption("false");
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await page
    .getByLabel("Criterion 2", { exact: true })
    .fill("one two three four five");
  await page.getByLabel("Criterion 2", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await expect(page.getByLabel("Criterion 2", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "false",
  );
  await first.hover();
  await remove.click();
  await expect(confirm).toBeVisible();
  await expect(first).toHaveValue("one two three four five six");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await first.hover();
  await remove.click();
  await first.fill("editing this question cancels deletion confirmation");
  await expect(confirm).toHaveCount(0);
  await first.hover();
  await remove.click();
  await page.getByLabel("Correct answer", { exact: true }).focus();
  await expect(confirm).toHaveCount(0);
  await first.hover();
  await remove.click();
  await confirm.click();
  await expect(first).toHaveCount(0);
  await expect(enabled).toBeChecked();
  await page.reload();
  await expect(first).toHaveCount(0);
  await expect(enabled).toBeChecked();
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await expect(first).toHaveValue("");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "true",
  );
});

test("criterion handles reorder questions and their answers by keyboard and pointer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  for (let index = 0; index < 3; index++) {
    if (index)
      await page
        .getByRole("button", { name: "Add criterion", exact: true })
        .click();
    await page
      .getByLabel(`Criterion ${index + 1}`, { exact: true })
      .fill(["First question", "Second question", "Third question"][index]);
    await page
      .getByLabel("Correct answer", { exact: true })
      .nth(index)
      .selectOption(index === 1 ? "true" : "false");
  }
  async function values() {
    return {
      questions: await page
        .getByRole("textbox", { name: /^Criterion \d+$/ })
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLTextAreaElement).value),
        ),
      answers: await page
        .getByLabel("Correct answer", { exact: true })
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLSelectElement).value),
        ),
    };
  }
  await page
    .getByRole("button", { name: "Move criterion 2", exact: true })
    .focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("button", { name: "Move criterion 1", exact: true }),
  ).toBeFocused();
  await expect.poll(values).toEqual({
    questions: ["Second question", "First question", "Third question"],
    answers: ["true", "false", "false"],
  });
  async function drag(from: number, target: number, side: "before" | "after") {
    const handle = page.getByRole("button", {
      name: `Move criterion ${from}`,
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const end = (await page
      .getByLabel(`Criterion ${target}`, { exact: true })
      .boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      end.x + end.width / 2,
      end.y + end.height * (side === "before" ? 0.2 : 0.8),
      { steps: 8 },
    );
    await page.mouse.up();
  }
  await drag(3, 1, "before");
  await expect.poll(values).toEqual({
    questions: ["Third question", "Second question", "First question"],
    answers: ["false", "true", "false"],
  });
  await drag(1, 3, "after");
  await expect.poll(values).toEqual({
    questions: ["Second question", "First question", "Third question"],
    answers: ["true", "false", "false"],
  });
  await page.reload();
  await expect.poll(values).toEqual({
    questions: ["Second question", "First question", "Third question"],
    answers: ["true", "false", "false"],
  });
});

test("removing a judge preserves ordinary axes and generation settings", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values", { exact: true }).fill("cat\ndog");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values", { exact: true }).fill("hat");
  await selectModel(page, "fixture/text");
  await page.getByLabel("Thinking effort", { exact: true }).selectOption("low");
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Describe $ROW wearing a $COLUMN");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("judge_effort");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .uncheck();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("effort");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("variable");
  await expect(page.getByLabel("Column values", { exact: true })).toHaveValue(
    "hat",
  );
  const models = page.getByRole("radiogroup", { name: "Model", exact: true });
  await expect(
    models.locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
  await expect(
    page
      .getByRole("group", { name: "Row values", exact: true })
      .getByRole("checkbox", { name: "Model default", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Describe $ROW wearing a $COLUMN",
  );
  await expect(
    page.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveCount(0);
  for (const side of ["Rows", "Columns"]) {
    const axis = page.getByRole("combobox", { name: side, exact: true });
    await expect(axis.locator('option[value="judge_model"]')).toHaveJSProperty(
      "disabled",
      true,
    );
    await expect(axis.locator('option[value="judge_effort"]')).toHaveJSProperty(
      "disabled",
      true,
    );
  }
});

test("format changes retain criteria and judge effort, clear incompatible models, and remove Website judging", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/other" ? { ...model, imageInput: false } : model,
    ),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByLabel("Criterion 1", { exact: true })
    .fill("Is there a blue circle?");
  await page
    .getByLabel("Correct answer", { exact: true })
    .selectOption("false");
  const judge = page.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await judge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture/other");
  await judge.locator('input[type="radio"][value="fixture/other"]').check();
  await page
    .getByLabel("Judge thinking effort", { exact: true })
    .selectOption("high");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
    "Is there a blue circle?",
  );
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "false",
  );
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await judge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(judge.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(
    judge.locator('input[type="radio"][value="fixture/other"]'),
  ).toHaveCount(0);
  await judge.locator('input[type="radio"][value="fixture/text"]').check();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await judge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture/text");
  await expect(
    judge.locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
    "Is there a blue circle?",
  );
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "false",
  );
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await expect(
    page
      .getByRole("combobox", { name: "Rows", exact: true })
      .locator('option[value="effort"]'),
  ).toHaveCount(0);
  await expect(page.getByLabel("Thinking effort", { exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "false",
  );
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await page
    .getByRole("button", { name: "Static website", exact: true })
    .click();
  await expect(
    page.getByText("Websites do not support a judge yet.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue(
    "true",
  );
  await judge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(judge.getByRole("radio", { checked: true })).toHaveCount(0);
  expect(await (await page.request.get("/fixture/calls")).json()).toEqual([]);
});

const judgedInput: GridInput = {
  format: "markdown",
  prompt: "Describe a red rectangle",
  model: "fixture/text",
  effort: "none",
  budgetUsd: 0.1,
  rows: { kind: "judge_model", values: ["fixture/text", "fixture/other"] },
  columns: { kind: "judge_effort", values: ["none", "high"] },
  judge: {
    criteria: [
      { text: "Is there a blue circle?", correctAnswer: false },
      { text: "Is there a red rectangle?", correctAnswer: true },
    ],
    model: "",
    effort: "default",
  },
};

async function createJudged(page: Page, input: GridInput = judgedInput) {
  await page.goto("/create");
  await page
    .getByRole("link", { name: "Connect OpenRouter", exact: true })
    .click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const response = await page.request.post("/api/grids", {
    headers: { origin: new URL(page.url()).origin },
    data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.goto(`/grid/${grid.id}`);
  return grid.id as string;
}

test("shared generation stays usable while judging; the scales popup scores expected answers and works expanded", async ({
  page,
}) => {
  await page.request.post("/fixture/reset", {
    data: {
      holdJudges: true,
      textCost: 0.1,
      judgeCost: 0.25,
      judgeOutput: JSON.stringify({
        results: [
          { verdict: false, explanation: "No blue circle." },
          { verdict: false, explanation: "No red rectangle." },
        ],
      }),
    },
  });
  const id = await createJudged(page);
  const scores = page.locator(".judge-result-button");
  await expect(scores).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: "Download output", exact: true }),
  ).toHaveCount(4);
  await expect(scores).toHaveText(["-/2", "-/2", "-/2", "-/2"]);
  await expect(
    page.getByLabel("Total cost: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Total spent: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".grid-cost .live-cost, .grid-spent .live-cost"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", {
      name: "10 input tokens, 20 output tokens",
      exact: true,
    }),
  ).toHaveCount(4);
  const generated = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(generated.spentUsd).toBe(0.1);
  await scores.first().click();
  const popup = page.getByRole("dialog", {
    name: "Judged output",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(popup.getByText("Correct", { exact: true })).toHaveCount(0);
  await expect(popup.getByText("Incorrect", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(scores.first()).toBeFocused();
  await page.request.post("/fixture/release", { data: { all: true } });
  const completed = page.getByRole("button", {
    name: "Judgment: 1 of 2 correct",
    exact: true,
  });
  await expect(completed).toHaveCount(4);
  await expect(completed).toHaveText(["1/2", "1/2", "1/2", "1/2"]);
  await expect(
    page.getByText("No blue circle.", { exact: true }),
  ).not.toBeVisible();
  await completed.first().focus();
  await page.keyboard.press("Enter");
  const items = popup.getByRole("listitem");
  await expect(
    items.nth(0).getByText("Correct", { exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(1).getByText("Incorrect", { exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(0).getByText("No blue circle.", { exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(1).getByText("No red rectangle.", { exact: true }),
  ).toBeVisible();
  expect(
    await items
      .nth(0)
      .getByText("Correct", { exact: true })
      .evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(
    await items
      .nth(1)
      .getByText("Incorrect", { exact: true })
      .evaluate((element) => getComputedStyle(element).color),
  );
  await popup
    .getByRole("button", { name: "Close judgment", exact: true })
    .click();
  await expect(completed.first()).toBeFocused();
  await completed.first().click();
  await page
    .getByRole("heading", { level: 1, name: judgedInput.prompt, exact: true })
    .click();
  await expect(popup).not.toBeVisible();
  await page
    .locator(".cell")
    .first()
    .getByRole("button", { name: "Expand Markdown", exact: true })
    .click();
  const expanded = page.getByRole("region", { name: /^Expanded output:/ });
  await expect(
    expanded.getByRole("link", { name: "Download output", exact: true }),
  ).toBeVisible();
  await expanded
    .getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true })
    .click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(grid.cells.map((cell: { usage: unknown }) => cell.usage)).toEqual(
    Array(4).fill({ inputTokens: 10, outputTokens: 20, costUsd: 0.1 }),
  );
  expect(grid.spentUsd).toBe(0.1);
  expect((await (await page.request.get("/fixture/calls")).json()).length).toBe(
    5,
  );
  expect(
    (await (await page.request.get("/fixture/judge-requests")).json()).length,
  ).toBe(4);
  await page
    .getByRole("button", { name: "Collapse Markdown", exact: true })
    .click();
  await expect(
    page.locator(".grid-cost .live-cost, .grid-spent .live-cost"),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true }),
  ).toHaveCount(4);
  await expect(
    page.getByLabel("Total cost: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Total spent: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "10 input tokens, 20 output tokens",
      exact: true,
    }),
  ).toHaveCount(4);
  await expect(
    page.locator(".grid-cost .live-cost, .grid-spent .live-cost"),
  ).toHaveCount(0);
  const reloaded = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(reloaded.spentUsd).toBe(generated.spentUsd);
  expect(reloaded.cells.map((cell: { usage: unknown }) => cell.usage)).toEqual(
    generated.cells.map((cell: { usage: unknown }) => cell.usage),
  );
  await page.goto("/billing");
  await expect(
    page.getByRole("cell", { name: "Judge", exact: true }),
  ).toHaveCount(4);
  const billing = await (await page.request.get("/api/billing")).json();
  expect(
    billing.calls
      .filter((call: { phase: string }) => call.phase === "judge")
      .map((call: { usage: { costUsd: number } }) => call.usage.costUsd),
  ).toEqual([0.25, 0.25, 0.25, 0.25]);
  expect(billing.costUsd).toBe(1.1);
});

test("failed judging shows unresolved criteria without hiding generation or its downloads", async ({
  page,
}) => {
  await page.request.post("/fixture/reset", {
    data: { judgeOutput: '{"results":[]}', textCost: 0.1 },
  });
  const id = await createJudged(page, {
    ...judgedInput,
    rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["high"] },
  });
  const score = page.getByRole("button", { name: /^Judging failed:/ });
  await expect(score).toHaveText("-/2");
  await expect(
    page.getByRole("link", { name: "Download output", exact: true }),
  ).toBeVisible();
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(
    (await page.request.get(`/outputs/${grid.cells[0].id}/download`)).status(),
  ).toBe(200);
  await score.click();
  const popup = page.getByRole("dialog", {
    name: "Judged output",
    exact: true,
  });
  await expect(popup.getByRole("status")).toContainText("Judging failed:");
  await expect(popup.getByText("Correct", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.getByLabel("Total cost: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(score).toHaveText("-/2");
  await page.goto("/billing");
  await expect(
    page.getByRole("cell", { name: "Judge", exact: true }),
  ).toHaveCount(1);
  const billing = await (await page.request.get("/api/billing")).json();
  expect(
    billing.calls.find((call: { phase: string }) => call.phase === "judge")
      .usage.costUsd,
  ).toBe(0.25);
  expect(billing.costUsd).toBe(0.35);
});

test("closing the page during judging does not stop completed judgments", async ({
  page,
  context,
}) => {
  await page.request.post("/fixture/reset", { data: { holdJudges: true } });
  const id = await createJudged(page, {
    ...judgedInput,
    rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["none"] },
  });
  await expect(
    page.getByRole("button", { name: "Judging...", exact: true }),
  ).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.close();
  await context.request.post(`${origin}/fixture/release`, {
    data: { all: true },
  });
  const reopened = await context.newPage();
  await reopened.goto(`${origin}/grid/${id}`);
  await expect(
    reopened.getByRole("button", {
      name: "Judgment: 2 of 2 correct",
      exact: true,
    }),
  ).toHaveText("2/2");
  expect(
    (await (await context.request.get(`${origin}/fixture/calls`)).json())
      .length,
  ).toBe(2);
});

test("judge answers and axes survive draft reload, OAuth, Edit, and Fork", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByLabel("Criterion 1", { exact: true })
    .fill(judgedInput.judge!.criteria[0].text);
  await page
    .getByLabel("Correct answer", { exact: true })
    .selectOption("false");
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await page
    .getByLabel("Criterion 2", { exact: true })
    .fill(judgedInput.judge!.criteria[1].text);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("judge_model");
  const rowModels = page.getByRole("group", {
    name: "Row values",
    exact: true,
  });
  await rowModels
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture");
  await rowModels
    .locator('input[type="checkbox"][value="fixture/text"]')
    .check();
  await rowModels
    .locator('input[type="checkbox"][value="fixture/other"]')
    .check();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("judge_effort");
  const columnEfforts = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await columnEfforts
    .getByRole("checkbox", { name: "Model default", exact: true })
    .uncheck();
  await columnEfforts
    .getByRole("checkbox", { name: "None", exact: true })
    .check();
  await columnEfforts
    .getByRole("checkbox", { name: "high", exact: true })
    .check();
  await selectModel(page, "fixture/text");
  await page
    .getByLabel("Thinking effort", { exact: true })
    .selectOption("none");
  await page.getByLabel("Prompt", { exact: true }).fill(judgedInput.prompt);
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.1");
  const expectRestored = async () => {
    await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
      judgedInput.judge!.criteria[0].text,
    );
    await expect(page.getByLabel("Criterion 2", { exact: true })).toHaveValue(
      judgedInput.judge!.criteria[1].text,
    );
    await expect(
      page.getByLabel("Correct answer", { exact: true }).nth(0),
    ).toHaveValue("false");
    await expect(
      page.getByLabel("Correct answer", { exact: true }).nth(1),
    ).toHaveValue("true");
    await expect(
      page.getByRole("combobox", { name: "Rows", exact: true }),
    ).toHaveValue("judge_model");
    await expect(
      page.getByRole("combobox", { name: "Columns", exact: true }),
    ).toHaveValue("judge_effort");
    await rowModels
      .getByRole("searchbox", { name: "Search judge models", exact: true })
      .fill("fixture");
    await expect(rowModels.locator("input:checked")).toHaveCount(2);
    await expect(
      rowModels.locator('input[type="checkbox"][value="fixture/text"]'),
    ).toBeChecked();
    await expect(
      rowModels.locator('input[type="checkbox"][value="fixture/other"]'),
    ).toBeChecked();
    await expect(
      columnEfforts.getByRole("checkbox", { checked: true }),
    ).toHaveCount(2);
    await expect(
      columnEfforts.getByRole("checkbox", { name: "None", exact: true }),
    ).toBeChecked();
    await expect(
      columnEfforts.getByRole("checkbox", { name: "high", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("radiogroup", { name: "Judge model", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("Judge thinking effort", { exact: true }),
    ).toHaveCount(0);
  };
  await page.reload();
  await expectRestored();
  await page
    .getByRole("link", { name: "Connect OpenRouter", exact: true })
    .click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expectRestored();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Judgment: 2 of 2 correct", exact: true }),
  ).toHaveCount(4);
  const original = page.url();
  const saved = await (
    await page.request.get(
      `/api/grids/${new URL(original).pathname.split("/").pop()}`,
    )
  ).json();
  expect(saved.input.judge.criteria).toEqual(judgedInput.judge!.criteria);
  expect((await (await page.request.get("/fixture/calls")).json()).length).toBe(
    5,
  );
  expect(
    (await (await page.request.get("/fixture/judge-requests")).json()).length,
  ).toBe(4);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expectRestored();
  await page.reload();
  await expectRestored();
  await page.goto(original);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expectRestored();
  await page.reload();
  await expectRestored();
  await expect(
    page.getByLabel("Reuse existing artifacts from the previous version", {
      exact: true,
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Judgment: 2 of 2 correct", exact: true }),
  ).toHaveCount(4);
  expect(page.url()).not.toBe(original);
  expect((await (await page.request.get("/fixture/calls")).json()).length).toBe(
    9,
  );
  expect(
    (await (await page.request.get("/fixture/judge-requests")).json()).length,
  ).toBe(8);
});

for (const format of ["svg", "image"] as const) {
  test(`${format} judgments use one shared image artifact and score expected answers`, async ({
    page,
  }) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>';
    await page.request.post("/fixture/reset", { data: { svgOutput: svg } });
    const input: GridInput = {
      ...judgedInput,
      format,
      model: format === "image" ? "fixture/image" : "fixture/text",
      judge: {
        ...judgedInput.judge!,
        criteria: [
          { text: "Is there a blue circle?", correctAnswer: false },
          {
            text:
              format === "svg"
                ? "Is there a red rectangle?"
                : "Is an image supplied?",
            correctAnswer: true,
          },
        ],
      },
    };
    const id = await createJudged(page, input);
    const scores = page.getByRole("button", {
      name: "Judgment: 2 of 2 correct",
      exact: true,
    });
    await expect(scores).toHaveCount(4);
    await expect(scores).toHaveText(["2/2", "2/2", "2/2", "2/2"]);
    const images = page.getByRole("img", {
      name: format === "svg" ? "Generated SVG" : "Generated image",
      exact: true,
    });
    await expect(images).toHaveCount(4);
    await expect
      .poll(() =>
        images
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(format === "svg" ? 40 : 1);
    const source = await images.first().getAttribute("src");
    const output = await page.request.get(source!);
    expect(output.status()).toBe(200);
    if (format === "svg")
      expect(await output.text()).toContain(
        '<rect width="40" height="20" fill="red"',
      );
    const requests = await (
      await page.request.get("/fixture/judge-requests")
    ).json();
    expect(requests).toHaveLength(4);
    const artifacts = requests.map(
      (request: {
        messages: {
          role: string;
          content: { type: string; image_url?: { url: string } }[];
        }[];
      }) =>
        request.messages
          .find((message) => message.role === "user")!
          .content.filter((part) => part.type === "image_url")
          .map((part) => part.image_url!.url),
    );
    expect(artifacts.every((artifact: string[]) => artifact.length === 1)).toBe(
      true,
    );
    expect(
      new Set(artifacts.map((artifact: string[]) => artifact[0])).size,
    ).toBe(1);
    expect(artifacts[0][0]).toMatch(/^data:image\/png;base64,/);
    const judgeBytes = Buffer.from(artifacts[0][0].split(",")[1], "base64");
    expect(judgeBytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    if (format === "image") expect(judgeBytes).toEqual(await output.body());
    if (format === "svg") {
      const raster = await page.evaluate(async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return {
          width: canvas.width,
          height: canvas.height,
          pixel: [...context.getImageData(20, 10, 1, 1).data],
        };
      }, artifacts[0][0]);
      expect(raster).toEqual({
        width: 40,
        height: 20,
        pixel: [255, 0, 0, 255],
      });
    }
    expect(
      (await (await page.request.get("/fixture/calls")).json()).length,
    ).toBe(5);
    await scores.first().click();
    const popup = page.getByRole("dialog", {
      name: "Judged output",
      exact: true,
    });
    await expect(popup.getByRole("listitem")).toHaveCount(2);
    await expect(popup.getByText("Correct", { exact: true })).toHaveCount(2);
    await expect(popup.getByText("Incorrect", { exact: true })).toHaveCount(0);
    await expect(
      popup.getByText("There is no blue circle.", { exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByText("The supplied output satisfies this criterion.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByText("There is no blue circle.", { exact: true }),
    ).not.toBeVisible();
    if (format === "svg") {
      await page.getByRole("button", { name: "EDIT", exact: true }).click();
      await page
        .getByLabel("Correct answer", { exact: true })
        .nth(0)
        .selectOption("true");
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      await expect(
        page.getByRole("button", {
          name: "Judgment: 1 of 2 correct",
          exact: true,
        }),
      ).toHaveCount(4);
      expect(new URL(page.url()).pathname).not.toBe(`/grid/${id}`);
      await page
        .getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true })
        .first()
        .click();
      const items = popup.getByRole("listitem");
      await expect(
        items.nth(0).getByText("Incorrect", { exact: true }),
      ).toBeVisible();
      await expect(
        items.nth(1).getByText("Correct", { exact: true }),
      ).toBeVisible();
      expect(
        (await (await page.request.get("/fixture/calls")).json()).length,
      ).toBe(9);
      expect(
        (await (await page.request.get("/fixture/judge-requests")).json())
          .length,
      ).toBe(8);
    }
  });
}
