import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  mockModels,
  selectModel,
  setVariableValues,
} from "./helpers";
import { currentDefinition } from "../current-grid-fixture";
import { acceptDrop } from "./judged-helpers";
test("judge criteria preserve boolean answers and differing judge axes reset only after confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const fixedJudge = judgeSection.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await fixedJudge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(fixedJudge.getByRole("radio", { checked: true })).toHaveCount(0);
  await judgeSection
    .getByLabel("Criterion 1", { exact: true })
    .fill("Is there a blue circle?");
  await judgeSection.getByLabel("Correct answer", { exact: true }).click();
  await page.reload();
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Is there a blue circle?");
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await judgeSection
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }).nth(1),
  ).toHaveAttribute("aria-pressed", "true");
  await judgeSection.getByLabel("Criterion 2", { exact: true }).hover();
  await judgeSection
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await judgeSection.getByLabel("Criterion 1", { exact: true }).hover();
  await judgeSection
    .getByRole("button", { name: "Remove criterion 1", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await fixedJudge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture/other");
  await fixedJudge
    .locator('input[type="radio"][value="fixture/other"]')
    .check();
  await judgeSection
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
    judgeSection.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toHaveCount(0);
  await expect(
    judgeSection.getByLabel("Judge thinking effort", { exact: true }),
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
  await acceptDrop(page, () =>
    page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable"),
  );
  await fixedJudge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture");
  await expect(fixedJudge.getByRole("radio", { checked: true })).toHaveCount(0);
  await acceptDrop(page, () =>
    page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("effort"),
  );
  await expect(
    judgeSection.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("default");
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
  ).toHaveValue("single");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("single");
  await expect(
    page.getByRole("checkbox", { name: "Add a LLM judge", exact: true }),
  ).not.toBeChecked();
});
test("the judge heading toggles judging without shifting its viewport position", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
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
      judgeSection.getByRole("radiogroup", {
        name: "Judge model",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => Math.abs((await checkbox.boundingBox())!.y - before))
      .toBeLessThan(1);
    await checkbox.uncheck();
    await expect(
      judgeSection.getByRole("radiogroup", {
        name: "Judge model",
        exact: true,
      }),
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
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  const first = judgeSection.getByLabel("Criterion 1", { exact: true });
  const remove = judgeSection.getByRole("button", {
    name: "Remove criterion 1",
    exact: true,
  });
  const confirm = page.getByRole("button", { name: "Delete", exact: true });
  await first.fill("one two three four five six");
  await judgeSection.getByLabel("Correct answer", { exact: true }).click();
  await judgeSection
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await judgeSection
    .getByLabel("Criterion 2", { exact: true })
    .fill("one two three four five");
  await judgeSection.getByLabel("Criterion 2", { exact: true }).hover();
  await judgeSection
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await expect(
    judgeSection.getByLabel("Criterion 2", { exact: true }),
  ).toHaveCount(0);
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
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
  await judgeSection.getByLabel("Correct answer", { exact: true }).focus();
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
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const emptyCriteriaInput = currentDefinition({
    judge: true,
    parameters: {
      judge_model: { kind: "rows" },
      judge_effort: { kind: "columns" },
      judge_criteria: { kind: "common", value: [] },
    },
    rows: [{ judge_model: "fixture/text" }],
    columns: [{ judge_effort: "high" }],
  });
  await page.evaluate((input) => {
    const draft = JSON.parse(sessionStorage.getItem("slopgrid-draft")!);
    draft.input = { ...input, budgetUsd: String(input.budgetUsd) };
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
  }, emptyCriteriaInput);
  await page.reload();
  await expect(first).toHaveCount(0);
  await expect(enabled).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("judge_model");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("judge_effort");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
});
test("criterion handles reorder questions and their answers by keyboard and pointer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  for (let index = 0; index < 3; index++) {
    if (index)
      await judgeSection
        .getByRole("button", { name: "Add criterion", exact: true })
        .click();
    await judgeSection
      .getByLabel(`Criterion ${index + 1}`, { exact: true })
      .fill(["First question", "Second question", "Third question"][index]);
    if (index !== 1)
      await judgeSection
        .getByLabel("Correct answer", { exact: true })
        .nth(index)
        .click();
  }
  async function values() {
    return {
      questions: await judgeSection
        .getByRole("textbox", { name: /^Criterion \d+$/ })
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLTextAreaElement).value),
        ),
      answers: await judgeSection
        .getByLabel("Correct answer", { exact: true })
        .evaluateAll((inputs) =>
          inputs.map((input) => input.getAttribute("aria-pressed")),
        ),
    };
  }
  await judgeSection
    .getByRole("button", { name: "Move criterion 2", exact: true })
    .focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    judgeSection.getByRole("button", { name: "Move criterion 1", exact: true }),
  ).toBeFocused();
  await expect.poll(values).toEqual({
    questions: ["Second question", "First question", "Third question"],
    answers: ["true", "false", "false"],
  });
  async function drag(from: number, target: number, side: "before" | "after") {
    const handle = judgeSection.getByRole("button", {
      name: `Move criterion ${from}`,
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const end = (await judgeSection
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
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Columns", ["hat"]);
  await selectModel(page, "fixture/text");
  const generatorEffort = page.getByRole("group", {
    name: "Row values",
    exact: true,
  });
  await generatorEffort
    .getByRole("checkbox", { name: "Model default", exact: true })
    .uncheck();
  await generatorEffort
    .getByRole("checkbox", { name: "high", exact: true })
    .check();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Describe a cat wearing a $COLUMN1");
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
  ).toHaveValue("single");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("variable");
  await expect(
    page.getByLabel("$COLUMN1, case 1", { exact: true }),
  ).toHaveValue("hat");
  const models = page.getByRole("radiogroup", { name: "Model", exact: true });
  await expect(
    models.locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
  await expect(page.getByLabel("Thinking effort", { exact: true })).toHaveValue(
    "high",
  );
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Describe a cat wearing a $COLUMN1",
  );
  await expect(
    page
      .getByRole("region", { name: "Judge", exact: true })
      .getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Judge", exact: true })
      .getByLabel("Judge thinking effort", { exact: true }),
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
test("chat input images block text-only judges and removing them restores eligibility", async ({
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
    .fill("Describe this image. $ROW1 one");
  for (let index = 2; index <= 4; index++) {
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
  }
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Describe the later image.");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["one"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await selectModel(page, "fixture/text");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  await judgeSection
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer describe the image?");
  const judge = judgeSection.getByRole("radiogroup", {
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
  await page
    .getByLabel("Add images to message 3", { exact: true })
    .setInputFiles({
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
  await expect(generate).toBeDisabled();
  await expect(judge.getByRole("cell", { name: /Unsupported/ })).toBeVisible();
  await page.reload();
  await search.fill("fixture");
  await expect(generate).toBeDisabled();
  await visionJudge.check();
  await expect(generate).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Remove judge-input.png from message 3",
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
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  await judgeSection
    .getByLabel("Criterion 1", { exact: true })
    .fill("Is there a blue circle?");
  await judgeSection.getByLabel("Correct answer", { exact: true }).click();
  const judge = judgeSection.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await judge
    .getByRole("searchbox", { name: "Search judge models", exact: true })
    .fill("fixture/other");
  await judge.locator('input[type="radio"][value="fixture/other"]').check();
  await judgeSection
    .getByLabel("Judge thinking effort", { exact: true })
    .selectOption("high");
  await acceptDrop(page, () =>
    page.getByRole("button", { name: "SVG", exact: true }).click(),
  );
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Is there a blue circle?");
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    judgeSection.getByLabel("Judge thinking effort", { exact: true }),
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
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Is there a blue circle?");
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    judgeSection.getByLabel("Judge thinking effort", { exact: true }),
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
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    judgeSection.getByLabel("Judge thinking effort", { exact: true }),
  ).toHaveValue("high");
  await acceptDrop(page, () =>
    page.getByRole("button", { name: "Static website", exact: true }).click(),
  );
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    judgeSection.getByRole("radiogroup", { name: "Judge model", exact: true }),
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
  await expect(
    judgeSection.getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    judgeSection.getByLabel("Correct answer", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await judge
    .getByRole("button", { name: "Clear judge model filter", exact: true })
    .click();
  await expect(judge.getByRole("radio", { checked: true })).toHaveCount(0);
});
