import { test, expect } from "./fixtures";
import { generatorInputForCell } from "../../server/generator-input";
import { connectOpenRouter, finishPublishing, selectModel } from "./helpers";
import { currentInput } from "../current-grid-fixture";
import { createJudged, judgedCriteria, judgedInput } from "./judged-helpers";

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
    rows: [{ id: "row-1", judge_model: "fixture/text" }],
    columns: [{ id: "column-1", judge_effort: "none" }],
    parameters: {
      ...judgedInput.parameters,
      judge_criteria: {
        kind: "common",
        value: [
          { text: "Is it blue?", correctAnswer: false },
          { text: "Is it red?", correctAnswer: true },
        ],
      },
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
    .getByRole("heading", {
      level: 1,
      name: generatorInputForCell(judgedInput, 0, 0)[0].content,
      exact: true,
    })
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
    items.nth(0).getByText(`not(${judgedCriteria[0].text})`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    items.nth(1).getByText(judgedCriteria[1].text, { exact: true }),
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
    rows: [{ id: "row-1", judge_model: "fixture/text" }],
    columns: [{ id: "column-1", judge_effort: "high" }],
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
    rows: [{ id: "row-1", judge_model: "fixture/text" }],
    columns: [{ id: "column-1", judge_effort: "none" }],
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
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  await judgeSection
    .getByLabel("Criterion 1", { exact: true })
    .fill(judgedCriteria[0].text);
  await judgeSection.getByLabel("Correct answer", { exact: true }).click();
  await judgeSection
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await judgeSection
    .getByLabel("Criterion 2", { exact: true })
    .fill(judgedCriteria[1].text);
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
  await page
    .getByLabel("Prompt", { exact: true })
    .fill(generatorInputForCell(judgedInput, 0, 0)[0].content);
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.1");
  const expectRestored = async () => {
    await expect(
      page.getByLabel("Budget limit per cell", { exact: true }),
    ).toHaveValue("0.1");
    await expect(
      judgeSection.getByLabel("Criterion 1", { exact: true }),
    ).toHaveValue(judgedCriteria[0].text);
    await expect(
      judgeSection.getByLabel("Criterion 2", { exact: true }),
    ).toHaveValue(judgedCriteria[1].text);
    await expect(
      judgeSection.getByLabel("Correct answer", { exact: true }).nth(0),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      judgeSection.getByLabel("Correct answer", { exact: true }).nth(1),
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
  expect(saved.input.parameters.judge_criteria).toEqual({
    kind: "common",
    value: judgedCriteria,
  });
  expect(saved.input.budgetUsd).toBe(0.1);
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
    const input = currentInput({
      format,
      budgetUsd: judgedInput.budgetUsd,
      judge: true,
      rows: judgedInput.rows,
      columns: judgedInput.columns,
      parameters: {
        input: judgedInput.parameters.input,
        ...(format === "svg"
          ? { effort: { kind: "common" as const, value: "none" as const } }
          : {}),
        judge_model: { kind: "rows" },
        judge_effort: { kind: "columns" },
        judge_criteria: {
          kind: "common",
          value: [
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
      },
    });
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
      await page
        .getByRole("region", { name: "Judge", exact: true })
        .getByLabel("Correct answer", { exact: true })
        .nth(0)
        .click();
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
    rows: [{ id: "row-1", judge_model: "fixture/text" }],
    columns: [{ id: "column-1", judge_effort: "none" }],
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
