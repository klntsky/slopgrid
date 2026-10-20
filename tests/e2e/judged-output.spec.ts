import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";
import {
  connectOpenRouter,
  finishPublishing,
  mockModels,
  scrollToRest,
  selectModel,
} from "./helpers";

type JudgmentScrollGeometry = {
  limit: number;
  height: number;
  scale: number;
  edges: number[];
};

function expectJudgmentFocus(
  source: JudgmentScrollGeometry & { position: number },
  target: JudgmentScrollGeometry & { position: number },
  criterion: number,
  focusFraction: number,
) {
  const start = criterion * 2;
  const fraction =
    (source.position + source.height * focusFraction - source.edges[start]) /
    (source.edges[start + 1] - source.edges[start]);
  const offset =
    target.edges[start] +
    (target.edges[start + 1] - target.edges[start]) * fraction -
    target.position -
    target.height * focusFraction;
  expect(target.position).toBeGreaterThanOrEqual(0);
  expect(target.position).toBeLessThanOrEqual(target.limit);
  if (target.position < 2) expect(offset).toBeLessThanOrEqual(2);
  else if (target.position > target.limit - 2)
    expect(offset).toBeGreaterThanOrEqual(-2);
  else expect(Math.abs(offset)).toBeLessThan(2);
}

function expectJudgmentAlignment(
  views: (JudgmentScrollGeometry & { position: number })[],
  leader: number,
  focusFraction: number,
) {
  const source = views[leader];
  const point = source.position + source.height * focusFraction;
  const start = source.edges.findIndex(
    (edge, index) =>
      index % 2 === 0 && edge <= point && source.edges[index + 1] >= point,
  );
  expect(
    start,
    "the persistent focus lies inside a rendered criterion",
  ).toBeGreaterThanOrEqual(0);
  expectJudgmentFocus(source, views[1 - leader], start / 2, focusFraction);
}

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
  await page.getByLabel("Correct answer", { exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
    "Is there a blue circle?",
  );
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await expect(
    page.getByLabel("Correct answer", { exact: true }).nth(1),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Criterion 2", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await page.getByLabel("Criterion 1", { exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove criterion 1", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
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

test("criterion deletion uses confirmation boundaries and disables the last judge", async ({
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
  await page.getByLabel("Correct answer", { exact: true }).click();
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
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
  await expect(enabled).not.toBeChecked();
  await page.reload();
  await expect(first).toHaveCount(0);
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await expect(first).toHaveValue("");
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem("slopgrid-draft")!);
    draft.input.judge.criteria = [];
    draft.input.rows = { kind: "judge_model", values: ["fixture/text"] };
    draft.input.columns = { kind: "judge_effort", values: ["high"] };
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
  });
  await page.reload();
  await expect(first).toHaveCount(0);
  await expect(enabled).not.toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("effort");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("model");
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
    if (index !== 1)
      await page
        .getByLabel("Correct answer", { exact: true })
        .nth(index)
        .click();
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
          inputs.map((input) => input.getAttribute("aria-pressed")),
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

test("chat input images require a vision judge and removing them restores text-only judges", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await connectOpenRouter(page);
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/other" ? { ...model, imageInput: false } : model,
    ),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Describe this image. $ROW $COLUMN");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values", { exact: true }).fill("one");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values", { exact: true }).fill("one");
  await selectModel(page, "fixture/text");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer describe the image?");
  const judge = page.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  const search = judge.getByRole("searchbox", {
    name: "Search judge models",
    exact: true,
  });
  const textJudge = judge.locator('input[type="radio"][value="fixture/other"]');
  const visionJudge = judge.locator(
    'input[type="radio"][value="fixture/text"]',
  );
  await search.fill("fixture");
  await textJudge.check();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeEnabled();
  await page.getByLabel("Add input references", { exact: true }).setInputFiles({
    name: "judge-input.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("img", { name: "judge-input.png", exact: true }),
  ).toBeVisible();
  await expect(textJudge).toHaveCount(0);
  await expect(generate).toBeDisabled();
  await page.reload();
  await search.fill("fixture");
  await expect(textJudge).toHaveCount(0);
  await expect(generate).toBeDisabled();
  await visionJudge.check();
  await expect(generate).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Remove judge-input.png from Input references",
      exact: true,
    })
    .click();
  await expect(textJudge).toBeVisible();
  await textJudge.check();
  await expect(textJudge).toBeChecked();
  await expect(generate).toBeEnabled();
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
  await page.getByLabel("Correct answer", { exact: true }).click();
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
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await page
    .getByRole("button", { name: "Static website", exact: true })
    .click();
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
  await expect(
    page.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await judge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(judge.getByRole("radio", { checked: true })).toHaveCount(0);
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
  await connectOpenRouter(page);
  const response = await page.request.post("/api/grids", {
    headers: { origin: new URL(page.url()).origin },
    data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.goto(`/grid/${grid.id}`);
  return grid.id as string;
}

test("judgments open automatically on completion and reload as a scrollable full-cell view", async ({
  page,
}) => {
  const finalExplanation = "The red rectangle is visible.";
  await page.request.post("/fixture/reset", {
    data: {
      holdGenerations: true,
      holdJudges: true,
      svgOutput:
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="red"/></svg>',
      judgeOutput: JSON.stringify({
        results: [
          {
            verdict: false,
            explanation: Array.from(
              { length: 60 },
              (_, index) =>
                `Detail ${index + 1}: the rectangle is red, not blue.`,
            ).join("\n"),
          },
          { verdict: true, explanation: finalExplanation },
        ],
      }),
    },
  });
  await createJudged(page, {
    ...judgedInput,
    format: "svg",
    rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["none"] },
    judge: {
      ...judgedInput.judge!,
      criteria: [
        { text: "Is it blue?", correctAnswer: false },
        { text: "Is it red?", correctAnswer: true },
      ],
    },
  });
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(1);
  const cell = page.locator(".cell");
  const score = cell.locator(".judge-result-button");
  await expect(score).toHaveCount(0);
  const held = await (await page.request.get("/fixture/workers")).json();
  await page.request.post("/fixture/release", {
    data: { prompt: held.held[0] },
  });
  await expect(score).toHaveAccessibleName("Judging...");
  await expect(score).toHaveAttribute("aria-busy", "true");
  await expect(score).toHaveText("/2");
  const image = cell.getByRole("img", { name: "Generated SVG", exact: true });
  await expect(image).toBeVisible();
  await score.click();
  const details = cell.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(image).toBeHidden();
  const viewport = (await cell.locator(".cell-view").last().boundingBox())!;
  expect(await details.boundingBox()).toEqual(viewport);
  await score.click();
  await expect(details).toBeHidden();

  await page.request.post("/fixture/release", { data: { all: true } });
  await expect(score).toHaveText("2/2");
  await expect(score).toHaveAttribute("aria-busy", "false");
  await expect(details).toBeVisible();
  await expect(score).toHaveAttribute("aria-pressed", "true");
  await expect(details.getByRole("status")).toHaveCount(0);
  expect(await details.boundingBox()).toEqual(viewport);
  expect(
    await details.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await details.hover();
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() => details.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    details.getByText(finalExplanation, { exact: true }),
  ).toBeInViewport();
  await expect(score).toBeVisible();
  await score.click();
  await expect(details).toBeHidden();
  await expect(image).toBeVisible();
  await page.reload();
  await expect(score).toHaveAttribute("aria-pressed", "true");
  await expect(details).toBeVisible();
});

test("shared generation stays usable across judgment views and persists expanded", async ({
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
  await expect(scores.first()).toHaveText("/2");
  await expect(scores.first()).toHaveAttribute("aria-busy", "true");
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
  const cell = page.locator(".cell").first();
  await cell.getByRole("button", { name: "View raw", exact: true }).click();
  const raw = cell.locator(".markdown-preview pre");
  await expect(raw).toHaveText("# A generated cat\n\nWearing a hat.");
  await scores.first().click();
  const details = cell.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(scores.first()).toHaveAttribute("aria-pressed", "true");
  await expect(raw).toBeHidden();
  await expect(
    details.getByRole("img", { name: /^(Correct|Incorrect)$/ }),
  ).toHaveCount(0);
  await expect(details.getByRole("status")).toContainText("Judging...");
  await expect(
    cell.getByRole("button", { name: "View raw", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    cell.getByRole("link", { name: "Open output", exact: true }),
  ).toBeVisible();
  await expect(
    cell.getByRole("button", { name: "Copy output", exact: true }),
  ).toBeVisible();
  await expect(
    cell.getByRole("link", { name: "Download output", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { level: 1, name: judgedInput.prompt, exact: true })
    .click();
  await expect(details).toBeVisible();
  await scores.first().click();
  await expect(details).toBeHidden();
  await expect(scores.first()).toHaveAttribute("aria-pressed", "false");
  await expect(raw).toBeHidden();
  await expect(
    cell.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  await scores.first().focus();
  await page.keyboard.press("Enter");
  await expect(details).toBeVisible();
  await page.request.post("/fixture/release", { data: { all: true } });
  const completed = page.getByRole("button", {
    name: "Judgment: 1 of 2 correct",
    exact: true,
  });
  await expect(completed).toHaveCount(4);
  await expect(completed).toHaveText(["1/2", "1/2", "1/2", "1/2"]);
  await expect(completed.first()).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByLabel("Total cost: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Total spent: $1.10", { exact: true }),
  ).toBeVisible();
  await expect(details).toBeVisible();
  const items = details.getByRole("listitem");
  await expect(
    items.nth(0).getByRole("img", { name: "Correct", exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(1).getByRole("img", { name: "Incorrect", exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(0).getByText(`not(${judgedInput.judge!.criteria[0].text})`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    items
      .nth(1)
      .getByText(judgedInput.judge!.criteria[1].text, { exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(0).getByText("No blue circle.", { exact: true }),
  ).toBeVisible();
  await expect(
    items.nth(1).getByText("No red rectangle.", { exact: true }),
  ).toBeVisible();
  await cell
    .getByRole("button", { name: "Expand judgment", exact: true })
    .click();
  const expanded = page.getByRole("region", { name: /^Expanded output:/ });
  const expandedDetails = expanded.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await expect(expandedDetails).toBeVisible();
  await expect(
    expanded.getByRole("link", { name: "Download output", exact: true }),
  ).toHaveCount(0);
  await expect(
    expanded.getByRole("button", { name: "Copy output", exact: true }),
  ).toHaveCount(0);
  const expandedScore = expanded.getByRole("button", {
    name: "Judgment: 1 of 2 correct",
    exact: true,
  });
  await expect(expandedScore).toHaveAttribute("aria-pressed", "true");
  await expandedScore.click();
  await expect(expandedDetails).toBeHidden();
  await expect(
    expanded.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  await expandedScore.click();
  await expanded
    .getByRole("button", { name: "Collapse judgment", exact: true })
    .click();
  await expect(details).toBeVisible();
  await expect(completed.first()).toHaveAttribute("aria-pressed", "true");
  await cell
    .getByRole("button", { name: "Expand judgment", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(details).toBeVisible();
  await completed.first().click();
  await expect(details).toBeHidden();
  await expect(raw).toBeHidden();
  await expect(
    cell.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  await completed.first().click();
  await completed.first().click();
  await expect(
    cell.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(grid.cells.map((cell: { usage: unknown }) => cell.usage)).toEqual(
    Array(4).fill({ inputTokens: 10, outputTokens: 20, costUsd: 0.1 }),
  );
  expect(grid.spentUsd).toBe(1.1);
  expect((await (await page.request.get("/fixture/calls")).json()).length).toBe(
    5,
  );
  expect(
    (await (await page.request.get("/fixture/judge-requests")).json()).length,
  ).toBe(4);
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
    page.getByLabel("Total spent: $1.10", { exact: true }),
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
  expect(reloaded.spentUsd).toBe(grid.spentUsd);
  expect(reloaded.cells.map((cell: { usage: unknown }) => cell.usage)).toEqual(
    generated.cells.map((cell: { usage: unknown }) => cell.usage),
  );
  await page.goto("/billing");
  await expect(
    page.getByRole("cell", { name: "judge", exact: true }),
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
  const cell = page.locator(".cell");
  const details = cell.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await expect(details.getByRole("status")).toContainText("Judging failed:");
  await expect(
    details.getByRole("img", { name: /^(Correct|Incorrect)$/ }),
  ).toHaveCount(0);
  await expect(
    cell.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toHaveCount(0);
  await expect(
    cell.getByRole("link", { name: "Open output", exact: true }),
  ).toBeVisible();
  await expect(
    cell.getByRole("button", { name: "Copy output", exact: true }),
  ).toBeVisible();
  await expect(
    cell.getByRole("link", { name: "Download output", exact: true }),
  ).toBeVisible();
  await cell
    .getByRole("button", { name: "Expand judgment", exact: true })
    .click();
  const expanded = page.getByRole("region", { name: /^Expanded output:/ });
  await expect(
    expanded.getByRole("region", { name: "Judgment details", exact: true }),
  ).toContainText("Judging failed:");
  await expect(
    expanded.getByRole("link", { name: "Download output", exact: true }),
  ).toHaveCount(0);
  await expanded
    .getByRole("button", { name: "Collapse judgment", exact: true })
    .click();
  await expect(details).toBeVisible();
  await score.click();
  await expect(details).toBeHidden();
  await expect(
    cell.getByRole("heading", { name: "A generated cat", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Total cost: $0.10", { exact: true }),
  ).toBeVisible();
  await expect(score).toHaveText("-/2");
  await page.goto("/billing");
  await expect(
    page.getByRole("cell", { name: "judge", exact: true }),
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
  await page.getByLabel("Correct answer", { exact: true }).click();
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
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByLabel("Correct answer", { exact: true }).nth(1),
    ).toHaveAttribute("aria-pressed", "true");
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
  await connectOpenRouter(page);
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
    for (const score of await scores.all()) await score.click();
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
    for (const score of await scores.all()) await score.click();
    const details = page.locator(".cell").first().getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await expect(details).toBeVisible();
    await expect(details.getByRole("listitem")).toHaveCount(2);
    await expect(
      details.getByRole("img", { name: "Correct", exact: true }),
    ).toHaveCount(2);
    await expect(
      details.getByRole("img", { name: "Incorrect", exact: true }),
    ).toHaveCount(0);
    await expect(
      details.getByText("There is no blue circle.", { exact: true }),
    ).toBeVisible();
    await expect(
      details.getByText("The supplied output satisfies this criterion.", {
        exact: true,
      }),
    ).toBeVisible();
    await scores.first().click();
    await expect(
      details.getByText("There is no blue circle.", { exact: true }),
    ).not.toBeVisible();
    if (format === "svg") {
      await page.getByRole("button", { name: "EDIT", exact: true }).click();
      await page.getByLabel("Correct answer", { exact: true }).nth(0).click();
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      await expect(
        page.getByRole("button", {
          name: "Judgment: 1 of 2 correct",
          exact: true,
        }),
      ).toHaveCount(4);
      expect(new URL(page.url()).pathname).not.toBe(`/grid/${id}`);
      const items = details.getByRole("listitem");
      await expect(
        items.nth(0).getByRole("img", { name: "Incorrect", exact: true }),
      ).toBeVisible();
      await expect(
        items.nth(1).getByRole("img", { name: "Correct", exact: true }),
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

test("output modes are exclusive and expansion retains the selected view", async ({
  page,
}) => {
  await page.request.post("/fixture/reset", {
    data: { costStreaming: true, holdJudges: true },
  });
  await createJudged(page, {
    ...judgedInput,
    rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["none"] },
  });
  const cell = page.locator(".cell");
  const rawButton = cell.getByRole("button", { name: "View raw", exact: true });
  const thinkingButton = cell.getByRole("button", {
    name: "Show thinking",
    exact: true,
  });
  const score = cell.getByRole("button", {
    name: /^(Judging\.\.\.|Judgment:)/,
  });
  const expand = cell.locator(".markdown-expand");
  const details = cell.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  const thinking = cell.getByRole("region", { name: /^Thinking:/ });
  const output = cell.getByRole("heading", { name: "Drawing", exact: true });
  const raw = cell.locator(".cell-view").first().locator(".markdown-raw");
  const expectMode = async (active: "raw" | "thinking" | "judgment" | null) => {
    for (const [mode, button] of [
      ["raw", rawButton],
      ["thinking", thinkingButton],
      ["judgment", score],
    ] as const) {
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute(
        "aria-pressed",
        String(active === mode),
      );
    }
  };
  await expect(score).toHaveText("/2");
  await expect(output).toBeVisible();
  await expectMode(null);
  await rawButton.click();
  await expect(raw).toContainText("# Drawing");
  await expectMode("raw");
  await thinkingButton.click();
  await expect(thinking).toContainText("Thinking through the drawing.");
  await expect(raw).toBeHidden();
  await expectMode("thinking");
  await thinkingButton.click();
  await expect(output).toBeVisible();
  await expectMode(null);
  await score.click();
  await expect(details).toBeVisible();
  await expect(thinking).toBeHidden();
  await expectMode("judgment");
  await rawButton.click();
  await expect(raw).toContainText("# Drawing");
  await expect(details).toBeHidden();
  await expectMode("raw");
  await rawButton.click();
  await expect(output).toBeVisible();
  await expectMode(null);

  await thinkingButton.click();
  await expand.click();
  const expanded = page.getByRole("region", { name: /^Expanded output:/ });
  await expect(expanded).toBeVisible();
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await expect(thinking).toBeVisible();
  await expectMode("thinking");
  await score.click();
  await expect(details).toBeVisible();
  await expectMode("judgment");
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await rawButton.click();
  await expect(raw).toContainText("# Drawing");
  await expectMode("raw");
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await rawButton.click();
  await expect(output).toBeVisible();
  await expectMode(null);
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await thinkingButton.click();
  await expand.click();
  await expect(expanded).toHaveCount(0);
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await expect(thinking).toBeVisible();
  await expectMode("thinking");
  await thinkingButton.click();
  await expect(output).toBeVisible();
  await expectMode(null);
  await page.request.post("/fixture/release", { data: { all: true } });
  await expect(score).toHaveText("2/2");
  await expect(details).toBeVisible();
  await expectMode("judgment");
});

test("judgment hover retains synchronized positions across exit and source changes", async ({
  page,
}) => {
  const criteria = Array.from({ length: 4 }, (_, index) => ({
    text: `Does the output satisfy condition ${index + 1}?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map((_, index) => ({
          verdict: true,
          explanation: Array.from(
            { length: index === 0 ? 6 : 60 },
            (_, line) =>
              `Condition ${index + 1}, detail ${line + 1}: the generated output satisfies the requested requirement and includes the relevant supporting detail.`,
          ).join("\n"),
        })),
      }),
    },
  });
  await createJudged(page, {
    ...judgedInput,
    rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["none", "high"] },
    judge: { ...judgedInput.judge!, criteria },
  });
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(1).waitFor({ state: "visible" });
  const handle = (await page
    .getByRole("separator", { name: "Resize column 1", exact: true })
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 - 220,
    handle.y + handle.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  const position = (
    container: HTMLElement,
    { index, offset }: { index: number; offset: number },
  ) => {
    const row = container.querySelector(".judge-result-criteria")!.children[
      index
    ];
    container.scrollTop +=
      row.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      offset;
  };
  const source = results.nth(0);
  const target = results.nth(1);
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
  const backgrounds = (index: number) =>
    results.evaluateAll(
      (containers, index) =>
        containers.map(
          (container) =>
            getComputedStyle(
              container.querySelector(".judge-result-criteria")!.children[
                index
              ],
            ).backgroundColor,
        ),
      index,
    );
  const unhovered = (await backgrounds(0))[0];
  const expectHighlighted = async (index: number) => {
    await expect
      .poll(async () => {
        const colors = await backgrounds(index);
        return (
          colors[0] !== unhovered &&
          colors.every((color) => color === colors[0])
        );
      })
      .toBe(true);
  };
  const sourceBox = (await source.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  const hoverSource = () =>
    page.mouse.move(sourceBox.x + 20, sourceBox.y + sourceBox.height / 2);
  const hoverTarget = () =>
    page.mouse.move(targetBox.x + 20, targetBox.y + targetBox.height / 2);
  const criterionAt = (box: { x: number; y: number; height: number }) =>
    page.evaluate(
      ({ x, y }) => {
        const row = document
          .elementFromPoint(x, y)
          ?.closest(".judge-result-criteria > li");
        return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
      },
      { x: box.x + 20, y: box.y + box.height / 2 },
    );
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await page.mouse.move(1, 1);
  await source.evaluate(position, { index: 1, offset: 80 });
  await target.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  });
  const original = await positions();
  await expect(
    target.locator(".judge-result-criteria > li").nth(1),
  ).not.toBeInViewport();

  // Hover alone reveals the peer; the source keeps its own reading position.
  await hoverSource();
  await expectHighlighted(1);
  expect((await positions())[0]).toBe(original[0]);
  await expect.poll(async () => (await positions())[1]).not.toBe(original[1]);
  const pointedFraction = await source
    .locator(".judge-result-criteria > li")
    .nth(1)
    .evaluate(
      (element, pointerY) => {
        const rect = element.getBoundingClientRect();
        return (pointerY - rect.top) / rect.height;
      },
      sourceBox.y + sourceBox.height / 2,
    );
  await expect
    .poll(() =>
      target.evaluate(
        (container, { fraction, focusFraction }) => {
          const row = container.querySelector(".judge-result-criteria")!
            .children[1];
          const rect = row.getBoundingClientRect();
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          const top = (rect.top - panel.top) / scale + container.scrollTop;
          const desired =
            top +
            (rect.height / scale) * fraction -
            focusFraction * container.clientHeight;
          const expected = Math.max(
            0,
            Math.min(container.scrollHeight - container.clientHeight, desired),
          );
          return Math.abs(container.scrollTop - expected) < 2;
        },
        { fraction: pointedFraction, focusFraction: 0.5 },
      ),
    )
    .toBe(true);

  // Real pointer movement across adjacent criteria changes the highlight.
  await source.evaluate((container) => {
    const row = container.querySelector(".judge-result-criteria")!
      .children[1] as HTMLElement;
    container.scrollTop =
      row.offsetTop + row.offsetHeight - container.clientHeight * 0.75;
  });
  // Crossing adjacent rows must switch criteria without ending the hover.
  const row = (await source
    .locator(".judge-result-criteria > li")
    .nth(1)
    .boundingBox())!;
  await page.mouse.move(sourceBox.x + 20, row.y + row.height - 1);
  await expectHighlighted(1);
  const beforeBoundary = (await positions())[1];
  await page.mouse.move(sourceBox.x + 20, row.y + row.height + 1);
  await expectHighlighted(2);
  const afterBoundary = (await positions())[1];
  expect(Math.abs(afterBoundary - beforeBoundary)).toBeLessThan(10);
  await page.mouse.move(sourceBox.x + 20, row.y + row.height - 1);
  await expectHighlighted(1);
  const synchronized = await positions();
  expect(synchronized[1]).not.toBe(original[1]);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(synchronized);
  await expect.poll(() => backgrounds(1)).toEqual([unhovered, unhovered]);

  // A new source starts at its latest synchronized position, not its old bottom.
  const targetCriterion = await criterionAt(targetBox);
  expect(targetCriterion).toBeGreaterThanOrEqual(0);
  await hoverTarget();
  await expectHighlighted(targetCriterion);
  await frames();
  const targetOwned = await positions();
  expect(targetOwned[1]).toBe(synchronized[1]);
  const sourceCriterion = await criterionAt(sourceBox);
  expect(sourceCriterion).toBeGreaterThanOrEqual(0);
  await hoverSource();
  await expectHighlighted(sourceCriterion);
  await frames();
  const transferred = await positions();
  expect(transferred[0]).toBe(targetOwned[0]);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(transferred);
  await expect
    .poll(() => backgrounds(sourceCriterion))
    .toEqual([unhovered, unhovered]);

  // Native scrolling a former follower preserves the source's native movement.
  await hoverSource();
  await expectHighlighted(sourceCriterion);
  const beforeNative = await positions();
  expect(beforeNative[0]).toBe(transferred[0]);
  await scrollToRest(source, () => page.mouse.wheel(0, 16));
  const userScrolled = await positions();
  expect(Math.abs(userScrolled[0] - beforeNative[0] - 16)).toBeLessThan(2);
  expect(userScrolled[1]).not.toBe(beforeNative[1]);
  const nativeCriterion = await criterionAt(sourceBox);
  expect(nativeCriterion).toBeGreaterThanOrEqual(0);
  await expectHighlighted(nativeCriterion);
  await page.mouse.move(1, 1);
  await expect.poll(positions).toEqual(userScrolled);
  await expect
    .poll(() => backgrounds(nativeCriterion))
    .toEqual([unhovered, unhovered]);
});

test("judgment hover aligns short criteria fractionally even when unequal views clip them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 3 }, (_, index) => ({
    text: `Is condition ${index + 1} satisfied?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map((_, index) => ({
          verdict: true,
          explanation:
            index === 1
              ? "The requested condition is satisfied."
              : `Condition ${index + 1} matches the requested output. `.repeat(
                  30,
                ),
        })),
      }),
    },
  });
  const id = await createJudged(page, {
    ...judgedInput,
    prompt: "Draw a red $ROW rectangle",
    rows: { kind: "variable", values: ["top", "bottom"] },
    columns: { kind: "judge_effort", values: ["none", "high"] },
    judge: { ...judgedInput.judge!, model: "fixture/text", criteria },
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(2)
      .waitFor({ state: "attached" });
  const source = results.first();
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        const row = container.querySelector(".judge-result-criteria")!
          .children[1];
        const rect = row.getBoundingClientRect();
        const scale = panel.height / container.clientHeight;
        return {
          position: container.scrollTop,
          scale,
          screenHeight: panel.height,
          top: (rect.top - panel.top) / scale,
          bottom: (rect.bottom - panel.top) / scale,
          rowHeight: rect.height / scale,
          height: container.clientHeight,
          max: container.scrollHeight - container.clientHeight,
        };
      }),
    );
  const cases = [
    { fraction: 0.75, edge: "middle" },
    { fraction: 0.5, edge: "bottom" },
    { fraction: 0.75, edge: "top" },
  ] as const;
  for (const { fraction, edge } of cases) {
    await page.mouse.move(1, 1);
    await source.evaluate((container, edge) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1];
      const panel = container.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const scale = panel.height / container.clientHeight;
      const top =
        edge === "bottom"
          ? container.clientHeight - rect.height / scale - 4
          : edge === "top"
            ? 8 - (rect.height / scale) * 0.75
            : 40;
      container.scrollTop += (rect.top - panel.top) / scale - top;
    }, edge);
    for (const [index, panel] of (await results.all()).entries()) {
      if (index === 0) continue;
      await panel.evaluate((container, index) => {
        const rect = container.getBoundingClientRect();
        const row = container
          .querySelector(".judge-result-criteria")!
          .children[1].getBoundingClientRect();
        const scale = rect.height / container.clientHeight;
        // This receiver already shows the entire criterion, but at the wrong line.
        if (index === 1)
          container.scrollTop += (row.top - rect.top) / scale - 180;
        else container.scrollTop = index === 2 ? container.scrollHeight : 0;
      }, index);
    }
    const before = await geometry();
    const row = (await source
      .locator(".judge-result-criteria > li")
      .nth(1)
      .boundingBox())!;
    const box = (await source.boundingBox())!;
    const pointerY = row.y + row.height * fraction;
    const focusFraction = (pointerY - box.y) / box.height;
    const expected = before.map((bounds, index) => {
      if (index === 0) return bounds.position;
      const top = bounds.position + bounds.top;
      const desired =
        top + bounds.rowHeight * fraction - focusFraction * bounds.height;
      return Math.max(0, Math.min(bounds.max, desired));
    });
    await page.mouse.move(box.x + 20, pointerY);
    await expect
      .poll(async () =>
        (await geometry()).every(
          (bounds, index) => Math.abs(bounds.position - expected[index]) < 2,
        ),
      )
      .toBe(true);
    const aligned = await geometry();
    for (let index = 1; index < aligned.length; index++) {
      const bounds = aligned[index];
      expect(bounds.position).toBeGreaterThanOrEqual(0);
      expect(bounds.position).toBeLessThanOrEqual(bounds.max);
      const offset =
        (bounds.top + bounds.rowHeight * fraction) * bounds.scale -
        focusFraction * bounds.screenHeight;
      if (bounds.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (bounds.position > bounds.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
    if (edge === "bottom") {
      expect(aligned[2].bottom).toBeGreaterThan(aligned[2].height + 2);
    } else if (edge === "top") {
      expect(aligned[1].top).toBeLessThan(-2);
    }
    const revealed = (await geometry()).map((bounds) => bounds.position);
    await page.mouse.move(box.x + 21, pointerY);
    await expect
      .poll(async () => (await geometry()).map((bounds) => bounds.position))
      .toEqual(revealed);
    await page.mouse.move(1, 1);
    await expect
      .poll(async () => (await geometry()).map((bounds) => bounds.position))
      .toEqual(revealed);
  }

  // A short peer must reverse as the live viewport percentage changes, rather
  // than retaining the alignment from an earlier cursor position.
  await page.mouse.move(1, 1);
  await results.evaluateAll((containers) => {
    containers.forEach((container, index) => {
      const height = container.clientHeight;
      container
        .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
        .forEach((row, item) => {
          row.style.height = `${
            height * (item === 1 ? (index === 0 ? 2 : 0.25) : 3)
          }px`;
          row.style.overflow = "hidden";
        });
    });
  });
  await source.evaluate((container) => {
    const row = container.querySelector(".judge-result-criteria")!.children[1];
    const panel = container.getBoundingClientRect();
    const scale = panel.height / container.clientHeight;
    container.scrollTop +=
      (row.getBoundingClientRect().top - panel.top) / scale -
      container.clientHeight * 0.05;
  });
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await frames();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height * 0.25);
  await frames();
  const seeded = await geometry();
  const assertAlignment = async (focusFraction: number) => {
    const views = await geometry();
    const fraction =
      (views[0].height * focusFraction - views[0].top) / views[0].rowHeight;
    for (const view of views.slice(1)) {
      const offset =
        view.top + view.rowHeight * fraction - view.height * focusFraction;
      if (view.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (view.position > view.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
    return views;
  };
  await assertAlignment(0.25);
  let previous = seeded;
  for (const fraction of [0.45, 0.35]) {
    await page.mouse.move(box.x + 20, box.y + box.height * fraction);
    await frames();
    const aligned = await assertAlignment(fraction);
    expect(aligned[0].position).toBe(seeded[0].position);
    for (let index = 1; index < aligned.length; index++) {
      if (fraction === 0.45)
        expect(aligned[index].position).toBeLessThan(previous[index].position);
      else
        expect(aligned[index].position).toBeGreaterThan(
          previous[index].position,
        );
    }
    previous = aligned;
  }
  const aligned = await geometry();
  await results.evaluateAll((containers) => {
    for (const container of containers) {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1];
      row.textContent = "Updated judgment content within the same full area.";
    }
  });
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    aligned.map((view) => view.position),
  );
  await scrollToRest(source, () => page.mouse.wheel(0, -48));
  const reversed = await geometry();
  expect(
    Math.abs(reversed[0].position - aligned[0].position + 48),
  ).toBeLessThan(2);
  await assertAlignment(0.35);
  await page.mouse.move(box.x + 21, box.y + box.height * 0.35);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
  await page.mouse.move(1, 1);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
  await page.mouse.move(box.x + 21, box.y + box.height * 0.35);
  await frames();
  expect((await geometry()).map((view) => view.position)).toEqual(
    reversed.map((view) => view.position),
  );
});

test("native judgment wheel aligns the criterion under a stationary cursor in unequal views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 4 }, (_, index) => ({
    text: `Condition ${index + 1}?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map((_, index) => ({
          verdict: true,
          explanation:
            index === 1
              ? "Matches."
              : `Condition ${index + 1} satisfies the requested output. `.repeat(
                  index === 3 ? 24 : 12,
                ),
        })),
      }),
    },
  });
  const id = await createJudged(page, {
    ...judgedInput,
    prompt: "Draw a red $ROW rectangle",
    rows: { kind: "variable", values: ["top", "bottom"] },
    columns: { kind: "judge_effort", values: ["none", "high"] },
    judge: { ...judgedInput.judge!, model: "fixture/text", criteria },
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(3)
      .waitFor({ state: "attached" });
  const source = results.first();
  const target = results.nth(1);
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((view) => view.scrollTop),
    );
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        return {
          position: container.scrollTop,
          max: container.scrollHeight - container.clientHeight,
          height: panel.height,
          width: panel.width,
          rows: Array.from(
            container.querySelectorAll(".judge-result-criteria > li"),
            (row) => {
              const rect = row.getBoundingClientRect();
              return {
                top: rect.top - panel.top,
                bottom: rect.bottom - panel.top,
                height: rect.height,
              };
            },
          ),
        };
      }),
    );
  const initial = await geometry();
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const box = (await source.boundingBox())!;
  const focusOffset = Math.min(100, box.height / 3);
  const pointerY = box.y + focusOffset;
  await page.mouse.move(box.x + 20, pointerY);
  await frames();
  const assertAlignment = async (leader: number, focus: number) => {
    const current = await geometry();
    const criterion = current[leader].rows.findIndex(
      (row) => row.top <= focus && row.bottom > focus,
    );
    // Criterion landmarks measure alignment only when the focus is inside one.
    if (criterion === -1) return;
    const sourceRow = current[leader].rows[criterion];
    const fraction = (focus - sourceRow.top) / sourceRow.height;
    const offsets = current.map((view) => {
      const row = view.rows[criterion];
      return (
        row.top +
        row.height * fraction -
        (focus / current[leader].height) * view.height
      );
    });
    for (let index = 0; index < current.length; index++) {
      if (index === leader) continue;
      const view = current[index];
      expect(view.position).toBeGreaterThanOrEqual(0);
      expect(view.position).toBeLessThanOrEqual(view.max);
      const offset = offsets[index];
      if (view.position < 2) expect(offset).toBeLessThanOrEqual(2);
      else if (view.position > view.max - 2)
        expect(offset).toBeGreaterThanOrEqual(-2);
      else expect(Math.abs(offset)).toBeLessThan(2);
    }
  };
  await assertAlignment(0, focusOffset);
  // Exercise each criterion with native wheel input.
  for (const row of initial[0].rows) {
    const before = await positions();
    const destination = Math.max(
      0,
      Math.min(initial[0].max, row.top + row.height / 2 - focusOffset),
    );
    const delta = destination - before[0];
    if (Math.abs(delta) < 1) continue;
    await scrollToRest(source, () => page.mouse.wheel(0, delta));
    const settled = await positions();
    // The browser, not peer alignment, owns the source's wheel displacement.
    expect(Math.abs(settled[0] - before[0] - delta)).toBeLessThan(2);
    await assertAlignment(0, focusOffset);
    // This idle cursor reveal must agree with scroll-time reveal, including
    // after the stationary pointer has crossed into another criterion.
    await page.mouse.move(box.x + 21, pointerY);
    await frames();
    expect(await positions()).toEqual(settled);
    await page.mouse.move(box.x + 20, pointerY);
    await frames();
    expect(await positions()).toEqual(settled);
  }

  // A former programmatic follower can take ownership with native wheel input.
  await target.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  });
  await frames();
  const targetBox = (await target.boundingBox())!;
  const targetFocus = targetBox.height / 2;
  await page.mouse.move(targetBox.x + 20, targetBox.y + targetFocus);
  await frames();
  await assertAlignment(1, targetFocus);
  const handoff = await positions();
  await scrollToRest(target, () => page.mouse.wheel(0, -48));
  const transferred = await positions();
  expect(Math.abs(transferred[1] - handoff[1] + 48)).toBeLessThan(2);
  await assertAlignment(1, targetFocus);
  expect(
    transferred.some(
      (position, index) =>
        index !== 1 && Math.abs(position - handoff[index]) > 2,
    ),
  ).toBe(true);
  await page.mouse.move(targetBox.x + 21, targetBox.y + targetFocus);
  await frames();
  expect(await positions()).toEqual(transferred);
});

test("judgment layout changes after desktop scrollend refresh a stationary cursor in unequal views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const criteria = Array.from({ length: 4 }, (_, index) => ({
    text: `Condition ${index + 1}?`,
    correctAnswer: true,
  }));
  await page.request.post("/fixture/reset", {
    data: {
      judgeOutput: JSON.stringify({
        results: criteria.map(() => ({
          verdict: true,
          explanation: "Matches.",
        })),
      }),
    },
  });
  const id = await createJudged(page, {
    ...judgedInput,
    prompt: "Draw a red $ROW rectangle",
    rows: { kind: "variable", values: ["top", "bottom"] },
    columns: { kind: "judge_effort", values: ["none", "high"] },
    judge: { ...judgedInput.judge!, model: "fixture/text", criteria },
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `slopgrid:grid:${id}:sizes`,
      JSON.stringify({ columns: [320, 240], rows: [460, 260] }),
    );
  }, id);
  await page.reload();
  const results = page.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await results.nth(3).waitFor({ state: "visible" });
  for (const panel of await results.all())
    await panel
      .locator(".judge-result-criteria > li")
      .nth(3)
      .waitFor({ state: "attached" });
  await results.evaluateAll((containers) => {
    containers.forEach((container, view) => {
      // Keep the native source fixed when an earlier criterion grows.
      (container as HTMLElement).style.overflowAnchor = "none";
      const height = container.clientHeight;
      const focusedHeight =
        view === 0 ? height / 2 : view === 1 ? height - 8 : height * 2;
      container
        .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
        .forEach((row, index) => {
          row.style.height = `${index === 1 ? focusedHeight : height * 2}px`;
          row.style.overflow = "hidden";
        });
    });
  });
  const source = results.first();
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const positions = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
  const geometry = () =>
    results.evaluateAll((containers) =>
      containers.map((container) => {
        const panel = container.getBoundingClientRect();
        const scale = panel.height / container.clientHeight;
        return {
          position: container.scrollTop,
          max: container.scrollHeight - container.clientHeight,
          height: container.clientHeight,
          screenHeight: panel.height,
          width: panel.width,
          scale,
          rows: Array.from(
            container.querySelectorAll(".judge-result-criteria > li"),
            (row) => {
              const rect = row.getBoundingClientRect();
              return {
                top: (rect.top - panel.top) / scale,
                bottom: (rect.bottom - panel.top) / scale,
                height: rect.height / scale,
              };
            },
          ),
        };
      }),
    );
  const backgrounds = () =>
    results.evaluateAll((containers) =>
      containers.map((container) =>
        Array.from(
          container.querySelectorAll(".judge-result-criteria > li"),
          (row) => getComputedStyle(row).backgroundColor,
        ),
      ),
    );
  await page.mouse.move(1, 1);
  await frames();
  const unhighlighted = await backgrounds();
  const initial = await geometry();
  const box = (await source.boundingBox())!;
  const focusOffset = Math.min(100, box.height / 3);
  const pointer = { x: box.x + 20, y: box.y + focusOffset };
  const hitCriterion = () =>
    source.evaluate((container, pointer) => {
      const row = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest(".judge-result-criteria > li");
      return Array.from(
        container.querySelectorAll(".judge-result-criteria > li"),
      ).findIndex((candidate) => candidate === row);
    }, pointer);
  await page.mouse.move(pointer.x, pointer.y);
  await frames();
  expect(await hitCriterion()).toBe(0);

  // Cross two criterion boundaries with one native scroll, without refreshing
  // the cursor. Neither the pre-scroll row nor the scroll-time row is the row
  // that the subsequent layout change should reveal.
  const before = await positions();
  const row = initial[0].rows[2];
  const delta = (row.top + row.height / 2) * initial[0].scale - focusOffset;
  await scrollToRest(source, () => page.mouse.wheel(0, delta));
  const scrolled = await positions();
  expect(Math.abs(scrolled[0] - before[0] - delta)).toBeLessThan(2);
  expect(await hitCriterion()).toBe(2);

  await source.evaluate((container, pointerY) => {
    const rows = container.querySelectorAll<HTMLElement>(
      ".judge-result-criteria > li",
    );
    const scale =
      container.getBoundingClientRect().height / container.clientHeight;
    const next = rows[1].getBoundingClientRect();
    const growth = (pointerY - next.top - next.height / 2) / scale;
    rows[0].style.height = `${
      parseFloat(getComputedStyle(rows[0]).height) + growth
    }px`;
  }, pointer.y);
  await expect.poll(hitCriterion).toBe(1);
  await expect
    .poll(async () =>
      (await backgrounds()).map((colors, view) =>
        colors.map((color, index) => color !== unhighlighted[view][index]),
      ),
    )
    .toEqual(Array.from({ length: 4 }, () => [false, true, false, false]));

  // Geometry reseeds the full-li correspondence at the same viewport percentage;
  // only native bounds can prevent alignment in short and tall receivers.
  await expect
    .poll(async () => {
      const current = await geometry();
      const sourceRow = current[0].rows[1];
      const fraction =
        (focusOffset / current[0].scale - sourceRow.top) / sourceRow.height;
      return (
        current[0].position === scrolled[0] &&
        current.slice(1).every((view) => {
          const row = view.rows[1];
          const focus = (focusOffset / box.height) * view.height;
          const offset = row.top + row.height * fraction - focus;
          if (view.position < 0 || view.position > view.max) return false;
          if (view.position <= 2) return offset <= 2;
          if (view.position >= view.max - 2) return offset >= -2;
          return Math.abs(offset) < 2;
        })
      );
    })
    .toBe(true);
  const settled = await positions();
  const highlighted = await backgrounds();
  expect(settled[0]).toBe(scrolled[0]);
  await frames();
  expect(await positions()).toEqual(settled);
  await page.mouse.move(pointer.x + 1, pointer.y);
  await frames();
  expect(await positions()).toEqual(settled);
  await frames();
  expect(await positions()).toEqual(settled);
  expect(await backgrounds()).toEqual(highlighted);
});

test.describe("touch judgment following", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("horizontal swipes over judgments pan the grid while vertical swipes scroll results", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 6 }, (_, index) => ({
      text: `Does condition ${index + 1} hold?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map(() => ({
            verdict: true,
            explanation: "The output satisfies this condition. ".repeat(12),
          })),
        }),
      },
    });
    const id = await createJudged(page, {
      ...judgedInput,
      rows: { kind: "judge_model", values: ["fixture/text"] },
      judge: { ...judgedInput.judge!, criteria },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [440, 440], rows: [460] }),
      );
    }, id);
    await page.reload();
    const grid = page.getByLabel("Generated output grid");
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await results.nth(1).waitFor({ state: "visible" });
    const source = results.first();
    await source
      .locator(".judge-result-verdict")
      .first()
      .waitFor({ state: "visible" });
    const client = await page.context().newCDPSession(page);
    const swipe = async (x: number, y: number, dx: number, dy: number) => {
      let timestamp = Date.now() / 1000;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
        timestamp,
      });
      for (let step = 1; step <= 6; step++)
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: x + (dx * step) / 6, y: y + (dy * step) / 6, id: 1 },
          ],
          timestamp: (timestamp += 0.032),
        });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
        timestamp: timestamp + 0.2,
      });
    };
    const box = (await source.boundingBox())!;
    const y = box.y + box.height / 2;
    await scrollToRest(grid, () => swipe(300, y, -120, 0));
    expect(await grid.evaluate((view) => view.scrollLeft)).toBeGreaterThan(60);
    expect(await source.evaluate((view) => view.scrollTop)).toBe(0);
    await grid.evaluate((view) => {
      view.scrollLeft = 0;
    });
    await scrollToRest(source, () => swipe(220, y + 40, 0, -120));
    expect(await source.evaluate((view) => view.scrollTop)).toBeGreaterThan(60);
    expect(await grid.evaluate((view) => view.scrollLeft)).toBe(0);
    await client.detach();
  });

  test("touch judgment taps establish a persistent viewport percentage through swipes and dismissal", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 6 }, (_, index) => ({
      text: `Does condition ${index + 1} hold?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map((_, index) => ({
            verdict: true,
            explanation:
              index === 1
                ? "Matches."
                : `Condition ${index + 1}: the red rectangle matches the requested output. `.repeat(
                    2,
                  ),
          })),
        }),
      },
    });
    const id = await createJudged(page, {
      ...judgedInput,
      rows: { kind: "judge_model", values: ["fixture/text"] },
      columns: { kind: "judge_effort", values: ["none", "high"] },
      judge: { ...judgedInput.judge!, criteria },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [140, 200], rows: [400] }),
      );
    }, id);
    await page.reload();
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await results.nth(1).waitFor({ state: "visible" });
    for (const panel of await results.all())
      await panel
        .locator(".judge-result-criteria > li")
        .nth(5)
        .waitFor({ state: "attached" });
    // Distinct adjacent height ratios distinguish fixed and moving focus lines.
    await results.evaluateAll((containers) => {
      const heights = [
        [520, 120, 900, 600, 600, 600],
        [780, 240, 450, 900, 900, 900],
      ];
      containers.forEach((container, index) => {
        if (index === 1) (container as HTMLElement).style.maxHeight = "260px";
        const rows = container.querySelectorAll<HTMLElement>(
          ".judge-result-criteria > li",
        );
        rows.forEach((row, item) => {
          row.style.height = `${heights[index][item]}px`;
          row.style.overflow = "hidden";
        });
      });
    });
    const source = results.nth(0);
    const target = results.nth(1);
    await source.evaluate((container) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1] as HTMLElement;
      const panel = container.getBoundingClientRect();
      const scale =
        panel.height / parseFloat(getComputedStyle(container).height);
      container.scrollTop +=
        (row.getBoundingClientRect().top - panel.top - 80) / scale;
    });
    await target.evaluate((container) => {
      container.scrollTop = container.scrollHeight;
    });
    const original = await target.evaluate((container) => container.scrollTop);
    const backgrounds = (index: number) =>
      results.evaluateAll(
        (containers, index) =>
          containers.map(
            (container) =>
              getComputedStyle(
                container.querySelector(".judge-result-criteria")!.children[
                  index
                ],
              ).backgroundColor,
          ),
        index,
      );
    const unselected = (await backgrounds(1))[0];
    const expectSelected = async (index: number) => {
      await expect
        .poll(async () => {
          const colors = await backgrounds(index);
          return colors[0] !== unselected && colors[0] === colors[1];
        })
        .toBe(true);
    };
    const a = (await source.boundingBox())!;
    const b = (await target.boundingBox())!;
    const focusFraction = 120 / a.height;
    const client = await page.context().newCDPSession(page);
    const untouched = await results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
    const scrollGeometry = () =>
      results.evaluateAll((containers) =>
        containers.map((container) => {
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          return {
            position: container.scrollTop,
            limit: container.scrollHeight - container.clientHeight,
            height: container.clientHeight,
            scale,
            edges: Array.from(
              container.querySelectorAll(".judge-result-criteria > li"),
              (row) => {
                const rect = row.getBoundingClientRect();
                return [
                  (rect.top - panel.top) / scale + container.scrollTop,
                  (rect.bottom - panel.top) / scale + container.scrollTop,
                ];
              },
            ).flat(),
          };
        }),
      );
    const tapGeometry = await scrollGeometry();
    const tappedFraction =
      (tapGeometry[0].position +
        focusFraction * tapGeometry[0].height -
        tapGeometry[0].edges[2]) /
      (tapGeometry[0].edges[3] - tapGeometry[0].edges[2]);
    const tapTarget = tapGeometry[1];
    const tapTop = tapTarget.edges[2];
    const tapBottom = tapTarget.edges[3];
    const tapDesired =
      tapTop +
      (tapBottom - tapTop) * tappedFraction -
      focusFraction * tapTarget.height;
    const tapExpected = Math.max(0, Math.min(tapTarget.limit, tapDesired));
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: a.x + 20, y: a.y + 120, id: 1 }],
    });
    await expect.poll(() => backgrounds(1)).toEqual([unselected, unselected]);
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(untouched);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expectSelected(1);
    await expect
      .poll(() => target.evaluate((container) => container.scrollTop))
      .not.toBe(original);
    expect(await source.evaluate((container) => container.scrollTop)).toBe(
      untouched[0],
    );
    await expect
      .poll(async () =>
        Math.abs(
          (await target.evaluate((container) => container.scrollTop)) -
            tapExpected,
        ),
      )
      .toBeLessThan(2);
    await source.evaluate((container) => {
      const row = container.querySelector(".judge-result-criteria")!
        .children[1] as HTMLElement;
      const panel = container.getBoundingClientRect();
      const scale =
        panel.height / parseFloat(getComputedStyle(container).height);
      // The reading line starts in criterion 1; the lower grab is in criterion 2.
      container.scrollTop +=
        (row.getBoundingClientRect().bottom - panel.top - 120) / scale - 10;
    });
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const before = await source.evaluate((container) => container.scrollTop);
    const selectedBackground = (await backgrounds(1))[0];
    const scrollSamples = await source.evaluateHandle((container) => {
      const colors: string[] = [];
      const momentumColors: string[] = [];
      let released = false;
      const release = () => {
        released = true;
      };
      const record = () => {
        for (const list of document.querySelectorAll(
          ".judge-result-criteria",
        )) {
          const color = getComputedStyle(list.children[1]).backgroundColor;
          colors.push(color);
          if (released) momentumColors.push(color);
        }
      };
      container.addEventListener("scroll", record, { passive: true });
      document.addEventListener("touchend", release, { once: true });
      return {
        colors,
        momentumColors,
        stop: () => {
          container.removeEventListener("scroll", record);
          document.removeEventListener("touchend", release);
        },
      };
    });
    const ended = results.evaluateAll(
      (containers) =>
        new Promise<number[]>((resolve) =>
          containers[0].addEventListener(
            "scrollend",
            () => resolve(containers.map((view) => view.scrollTop)),
            { once: true },
          ),
        ),
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: a.x + 20, y: a.y + 260, id: 1 }],
    });
    await expectSelected(1);
    const dragGeometry = await scrollGeometry();
    for (const y of [245, 210, 170])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: a.x + 20, y: a.y + y, id: 1 }],
      });
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const duringDrag = await scrollGeometry();
    expect(duringDrag[0].position).toBeGreaterThan(before);
    // The lower grab keeps the tap's percentage, even in the shorter receiver.
    expect(duringDrag[0].position).toBeGreaterThan(dragGeometry[0].position);
    expectJudgmentAlignment(duringDrag, 0, focusFraction);
    for (const y of [130, 90, 20, -40, -100, -180])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: a.x + 20, y: a.y + y, id: 1 }],
      });
    const released = await source.evaluate((container) => container.scrollTop);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => source.evaluate((container) => container.scrollTop))
      .toBeGreaterThan(before);
    const endPositions = await ended;
    const duringScroll = await scrollSamples.evaluate((state) => {
      state.stop();
      return { colors: state.colors, momentumColors: state.momentumColors };
    });
    await scrollSamples.dispose();
    expect(new Set(duringScroll.colors)).toEqual(new Set([selectedBackground]));
    expect(endPositions[0]).toBeGreaterThan(released);
    expect(new Set(duringScroll.momentumColors)).toEqual(
      new Set([selectedBackground]),
    );
    const criterionAt = ({ x, y }: { x: number; y: number }) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest(".judge-result-criteria > li");
      return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
    };
    const readingCriterion = await page.evaluate(criterionAt, {
      x: a.x + 20,
      y: a.y + 120,
    });
    expect(readingCriterion).toBeGreaterThan(1);
    await expectSelected(readingCriterion);
    const settledGeometry = await scrollGeometry();
    expectJudgmentAlignment(settledGeometry, 0, focusFraction);
    await source.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(endPositions);
    const next = await page.evaluate(criterionAt, {
      x: b.x + 20,
      y: b.y + 140,
    });
    expect(next).toBeGreaterThanOrEqual(0);
    await page.touchscreen.tap(b.x + 20, b.y + 140);
    await expectSelected(next);
    const transferredGeometry = await scrollGeometry();
    expectJudgmentFocus(
      transferredGeometry[1],
      transferredGeometry[0],
      next,
      140 / b.height,
    );
    const dismissedPositions = await results.evaluateAll((containers) =>
      containers.map((container) => container.scrollTop),
    );
    await page
      .getByRole("button", { name: "Navigation menu", exact: true })
      .tap();
    await expect
      .poll(() => backgrounds(next))
      .toEqual([unselected, unselected]);
    expect(
      await results.evaluateAll((containers) =>
        containers.map((container) => container.scrollTop),
      ),
    ).toEqual(dismissedPositions);
    await client.detach();
  });

  test("first judgment swipe defaults to the upper third across unequal cells", async ({
    page,
  }) => {
    const criteria = Array.from({ length: 10 }, (_, index) => ({
      text: `Condition ${index + 1}?`,
      correctAnswer: true,
    }));
    await page.request.post("/fixture/reset", {
      data: {
        judgeOutput: JSON.stringify({
          results: criteria.map(() => ({
            verdict: true,
            explanation: "Matches.",
          })),
        }),
      },
    });
    const id = await createJudged(page, {
      ...judgedInput,
      rows: { kind: "judge_model", values: ["fixture/text"] },
      columns: { kind: "judge_effort", values: ["none", "high"] },
      judge: { ...judgedInput.judge!, criteria },
    });
    await page.evaluate((id) => {
      localStorage.setItem(
        `slopgrid:grid:${id}:sizes`,
        JSON.stringify({ columns: [140, 200], rows: [400] }),
      );
    }, id);
    await page.reload();
    const results = page.getByRole("region", {
      name: "Judgment details",
      exact: true,
    });
    await expect(results).toHaveCount(2);
    await results.evaluateAll((containers) => {
      containers.forEach((container, index) => {
        if (index === 1) (container as HTMLElement).style.maxHeight = "260px";
        const height = container.clientHeight;
        const ratios =
          index === 0
            ? [0.45, 0.25, 1.25, 0.8, 1.5, 0.9, 1.4, 1, 1.2, 1.5]
            : [0.75, 0.4, 0.7, 1.3, 0.8, 1.5, 1, 1.4, 0.9, 1.2];
        container
          .querySelectorAll<HTMLElement>(".judge-result-criteria > li")
          .forEach((row, item) => {
            row.style.height = `${height * ratios[item]}px`;
            row.style.overflow = "hidden";
          });
        container.scrollTop = index * 70;
      });
    });
    const backgrounds = (index: number) =>
      results.evaluateAll(
        (containers, index) =>
          containers.map(
            (container) =>
              getComputedStyle(
                container.querySelector(".judge-result-criteria")!.children[
                  index
                ],
              ).backgroundColor,
          ),
        index,
      );
    const unselected = (await backgrounds(0))[0];
    const expectSelected = async (index: number) => {
      await expect
        .poll(async () => {
          const colors = await backgrounds(index);
          return colors[0] !== unselected && colors[0] === colors[1];
        })
        .toBe(true);
    };
    const geometry = () =>
      results.evaluateAll((containers) =>
        containers.map((container) => {
          const panel = container.getBoundingClientRect();
          const scale = panel.height / container.clientHeight;
          return {
            position: container.scrollTop,
            limit: container.scrollHeight - container.clientHeight,
            height: container.clientHeight,
            scale,
            edges: Array.from(
              container.querySelectorAll(".judge-result-criteria > li"),
              (row) => {
                const rect = row.getBoundingClientRect();
                return [
                  (rect.top - panel.top) / scale + container.scrollTop,
                  (rect.bottom - panel.top) / scale + container.scrollTop,
                ];
              },
            ).flat(),
          };
        }),
      );
    const criterionAt = ({ x, y }: { x: number; y: number }) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest(".judge-result-criteria > li");
      return row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
    };
    const client = await page.context().newCDPSession(page);
    let selected = -1;
    // The second swipe switches native leader, with a different finger grab.
    for (const leader of [0, 1]) {
      const panel = (await results.nth(leader).boundingBox())!;
      const point = {
        x: panel.x + 20,
        y: panel.y + panel.height * (leader === 0 ? 0.85 : 0.65),
      };
      const reading = await page.evaluate(criterionAt, {
        x: point.x,
        y: panel.y + panel.height / 3,
      });
      expect(reading).toBeGreaterThanOrEqual(0);
      const before = await geometry();
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...point, id: 1 }],
      });
      expect((await geometry()).map((view) => view.position)).toEqual(
        before.map((view) => view.position),
      );
      if (selected < 0)
        await expect
          .poll(() => backgrounds(reading))
          .toEqual([unselected, unselected]);
      else await expectSelected(selected);
      const ended = results.evaluateAll(
        (containers, leader) =>
          new Promise<number[]>((resolve) =>
            containers[leader].addEventListener(
              "scrollend",
              () => resolve(containers.map((view) => view.scrollTop)),
              { once: true },
            ),
          ),
        leader,
      );
      for (const distance of [15, 40, 70, 100])
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: point.x, y: point.y - distance, id: 1 }],
        });
      await expect
        .poll(() =>
          results.nth(leader).evaluate((container) => container.scrollTop),
        )
        .toBeGreaterThan(before[leader].position + 50);
      await expectSelected(reading);
      const during = await geometry();
      expect(during[leader].position - before[leader].position).toBeLessThan(
        110,
      );
      expectJudgmentAlignment(during, leader, 1 / 3);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const finalPositions = await ended;
      selected = await page.evaluate(criterionAt, {
        x: point.x,
        y: panel.y + panel.height / 3,
      });
      expect(selected).toBeGreaterThanOrEqual(0);
      await expectSelected(selected);
      const settled = await geometry();
      expectJudgmentAlignment(settled, leader, 1 / 3);
      expect(
        await results.evaluateAll((containers) =>
          containers.map((container) => container.scrollTop),
        ),
      ).toEqual(finalPositions);
    }
    await client.detach();
  });
});
