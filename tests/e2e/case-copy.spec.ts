import type { Page } from "@playwright/test";
import type { Cell, GridDraftInput, GridInput } from "../../server/domain";
import { referencePng } from "../reference-image-fixture";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  defineCases,
  expectProgress,
  setVariableValues,
} from "./helpers";

async function savedInput(page: Page): Promise<GridDraftInput> {
  return page.evaluate(
    () => JSON.parse(sessionStorage.getItem("slopgrid-draft")!).input,
  );
}

for (const orientation of ["Rows", "Columns"] as const) {
  const side = orientation === "Rows" ? "rows" : "columns";
  const title = orientation === "Rows" ? "Row" : "Column";
  const token = orientation === "Rows" ? "$ROW1" : "$COLUMN1";

  test(`${orientation} append the focused non-last case with its complete configuration and widget filters`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", {
      data: { markdownOutput: "A copied case answer." },
    });
    const uploads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/api/references")
        uploads.push(url.searchParams.get("name")!);
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page
      .getByRole("combobox", { name: orientation, exact: true })
      .selectOption("variable");
    await setVariableValues(page, orientation, ["Alpha", "Beta"]);
    await page
      .getByRole("combobox", {
        name: orientation === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .selectOption("single");
    await page
      .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
      .check();
    for (const parameter of [
      "prompt",
      "model",
      "thinking effort",
      "judge model",
      "judge thinking effort",
      "judge criteria",
    ])
      await defineCases(page, parameter);

    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const group = (index: number, parameter: string) =>
      table.getByRole("group", {
        name: `${title} case ${index} ${parameter}`,
        exact: true,
      });
    const variable = (index: number) =>
      table.getByLabel(`${token}, case ${index}`, { exact: true });
    const generatorFilter = "  Fixture t ";
    const judgeFilter = " Second m ";
    for (const index of [1, 2]) {
      const first = index === 1;
      const modelId = first ? "fixture/text" : "fixture/other";
      const judgeId = first ? "fixture/other" : "fixture/text";
      await group(index, "Prompt")
        .getByLabel("Prompt", { exact: true })
        .fill(`${first ? "Source" : "Other"} asks ${token}.`);
      const model = group(index, "Model");
      await model.getByRole("searchbox").fill(modelId);
      await model.locator(`input[type="radio"][value="${modelId}"]`).check();
      await model
        .getByRole("searchbox")
        .fill(first ? generatorFilter : "Second model");
      await group(index, "Thinking effort")
        .getByRole("combobox")
        .selectOption(first ? "high" : "low");
      const judge = group(index, "Judge model");
      await judge.getByRole("searchbox").fill(judgeId);
      await judge.locator(`input[type="radio"][value="${judgeId}"]`).check();
      await judge
        .getByRole("searchbox")
        .fill(first ? judgeFilter : "Fixture text");
      await group(index, "Judge thinking effort")
        .getByRole("combobox")
        .selectOption(first ? "medium" : "high");
      await group(index, "judge criteria")
        .getByLabel("Criterion 1", { exact: true })
        .fill(`${first ? "Source" : "Other"} criterion for ${token}?`);
    }
    const sourceCriteria = group(1, "judge criteria");
    await sourceCriteria
      .getByRole("button", { name: "Add criterion", exact: true })
      .click();
    await sourceCriteria
      .getByLabel("Criterion 2", { exact: true })
      .fill("Does the output contain a blue circle?");
    await sourceCriteria
      .getByLabel("Correct answer", { exact: true })
      .nth(1)
      .click();
    await group(1, "Prompt")
      .getByLabel("Add images to prompt", { exact: true })
      .setInputFiles({
        name: "source-prompt.png",
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      group(1, "Prompt").getByRole("img", {
        name: "source-prompt.png",
        exact: true,
      }),
    ).toBeVisible();
    await table
      .getByLabel(`Add images to ${token}, case 1`, { exact: true })
      .setInputFiles({
        name: "source-variable.png",
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      table.getByRole("img", { name: "source-variable.png", exact: true }),
    ).toBeVisible();
    await variable(2).fill("Beta revised");
    const before = await savedInput(page);

    await group(1, "Thinking effort").getByRole("combobox").focus();
    await page.getByRole("button", { name: "new case", exact: true }).click();
    await expect(variable(3)).toHaveValue("Alpha");
    await expect(
      group(3, "Prompt").getByLabel("Prompt", { exact: true }),
    ).toHaveValue(`Source asks ${token}.`);
    await expect(group(3, "Model").getByRole("searchbox")).toHaveValue(
      generatorFilter,
    );
    await expect(
      group(3, "Model").locator('input[type="radio"][value="fixture/text"]'),
    ).toBeChecked();
    await expect(group(3, "Judge model").getByRole("searchbox")).toHaveValue(
      judgeFilter,
    );
    await expect(
      group(3, "Judge model").locator(
        'input[type="radio"][value="fixture/other"]',
      ),
    ).toBeChecked();
    await expect(group(3, "Thinking effort").getByRole("combobox")).toHaveValue(
      "high",
    );
    await expect(
      group(3, "Judge thinking effort").getByRole("combobox"),
    ).toHaveValue("medium");
    await expect(
      group(3, "judge criteria").getByLabel("Criterion 2", { exact: true }),
    ).toHaveValue("Does the output contain a blue circle?");
    await expect(
      group(3, "judge criteria")
        .getByLabel("Correct answer", { exact: true })
        .nth(1),
    ).toHaveAttribute("aria-pressed", "false");
    for (const name of ["source-prompt.png", "source-variable.png"])
      await expect(table.getByRole("img", { name, exact: true })).toHaveCount(
        2,
      );
    const copied = await savedInput(page);
    const { id: sourceId, ...sourceValues } = before[side][0];
    const { id: copiedId, ...copiedValues } = copied[side][2];
    expect(copied[side].slice(0, 2)).toEqual(before[side]);
    expect(copiedValues).toEqual(sourceValues);
    expect(before[side].map(({ id }) => id)).not.toContain(copiedId);
    expect(copiedId).not.toBe(sourceId);

    await variable(3).fill("Gamma");
    await group(3, "Prompt")
      .getByLabel("Prompt", { exact: true })
      .fill(`Copy asks ${token}.`);
    await group(3, "Prompt")
      .getByRole("button", {
        name: "Remove source-prompt.png from prompt",
        exact: true,
      })
      .click();
    await group(3, "judge criteria")
      .getByLabel("Criterion 1", { exact: true })
      .fill(`Copied criterion for ${token}?`);
    await group(3, "Model").getByRole("searchbox").fill("fixture/other");
    await group(3, "Model")
      .locator('input[type="radio"][value="fixture/other"]')
      .check();
    await group(3, "Thinking effort").getByRole("combobox").selectOption("low");
    await group(3, "Judge model")
      .getByRole("button", { name: "Clear judge model filter", exact: true })
      .click();
    await expect(group(3, "Judge model").getByRole("searchbox")).toHaveValue(
      "",
    );
    await group(3, "Judge model")
      .locator('input[type="radio"][value="fixture/text"]')
      .check();
    await group(3, "Judge thinking effort")
      .getByRole("combobox")
      .selectOption("high");
    await expect(group(1, "Model").getByRole("searchbox")).toHaveValue(
      generatorFilter,
    );
    await expect(group(1, "Judge model").getByRole("searchbox")).toHaveValue(
      judgeFilter,
    );
    await expect(
      group(1, "Prompt").getByRole("img", {
        name: "source-prompt.png",
        exact: true,
      }),
    ).toBeVisible();
    const edited = await savedInput(page);
    expect(edited[side].slice(0, 2)).toEqual(before[side]);
    expect(edited[side][2].id).toBe(copiedId);
    expect(edited[side][2].variable![0]!.images).toEqual(
      before[side][0].variable![0]!.images,
    );
    expect(JSON.stringify(edited)).not.toContain(generatorFilter);
    expect(JSON.stringify(edited)).not.toContain(judgeFilter);
    expect(uploads).toEqual([]);

    await connectOpenRouter(page);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/grids",
    );
    await page
      .getByRole("button", { name: "Generate", exact: true })
      .click({ timeout: 5000 });
    const response = await created;
    expect(response.status()).toBe(201);
    const submitted = response.request().postDataJSON();
    expect(JSON.stringify(submitted)).not.toContain(generatorFilter);
    expect(JSON.stringify(submitted)).not.toContain(judgeFilter);
    const { id } = await response.json();
    await expectProgress(page, 3, 3);
    const snapshot = await page.request.get(`/api/grids/${id}`);
    expect(snapshot.status()).toBe(200);
    const grid: { input: GridInput; cells: Cell[] } = await snapshot.json();
    expect(uploads.sort()).toEqual([
      "source-prompt.png",
      "source-variable.png",
    ]);
    expect(grid.input[side].map(({ id }) => id)).toEqual(
      edited[side].map(({ id }) => id),
    );
    expect(grid.input[side][2].variable![0]!.images).toEqual(
      grid.input[side][0].variable![0]!.images,
    );
    for (const input of [submitted, grid.input]) {
      expect(JSON.stringify(input)).not.toMatch(
        /"[^"]*(?:filter|focus)[^"]*":/i,
      );
    }
    const position = side === "rows" ? "row" : "column";
    const cells = [...grid.cells].sort(
      (left, right) => left[position] - right[position],
    );
    expect(
      cells.map((cell) => [
        cell.prompt,
        cell.model,
        cell.effort,
        cell.judge?.model,
        cell.judge?.effort,
      ]),
    ).toEqual([
      ["Source asks Alpha.", "fixture/text", "high", "fixture/other", "medium"],
      [
        "Other asks Beta revised.",
        "fixture/other",
        "low",
        "fixture/text",
        "high",
      ],
      ["Copy asks Gamma.", "fixture/other", "low", "fixture/text", "high"],
    ]);
    expect(cells[0].judge?.criteria).toEqual([
      { text: "Source criterion for Alpha?", correctAnswer: true },
      { text: "Does the output contain a blue circle?", correctAnswer: false },
    ]);
    expect(cells[2].judge?.criteria).toEqual([
      { text: "Copied criterion for Gamma?", correctAnswer: true },
      { text: "Does the output contain a blue circle?", correctAnswer: false },
    ]);
    expect(
      grid.input[side].map((record) =>
        [
          ...(record.input?.flatMap((message) => message.images ?? []) ?? []),
          ...(record.variable?.flatMap((field) => field?.images ?? []) ?? []),
        ].map(({ name }) => name),
      ),
    ).toEqual([
      ["source-prompt.png", "source-variable.png"],
      [],
      ["source-variable.png"],
    ]);
  });

  test(`${orientation} fall back to the last case after reload or removal of the focused case`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page
      .getByRole("combobox", { name: orientation, exact: true })
      .selectOption("variable");
    await setVariableValues(page, orientation, ["Alpha", "Beta", "Gamma"]);
    await page.reload();
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const variable = (index: number) =>
      table.getByLabel(`${token}, case ${index}`, { exact: true });
    const add = page.getByRole("button", { name: "new case", exact: true });
    await add.click();
    await expect(variable(4)).toHaveValue("Gamma");
    await variable(1).focus();
    await table
      .getByRole("button", {
        name: `Remove ${title.toLowerCase()} case 1`,
        exact: true,
      })
      .click();
    await add.click();
    for (const [index, value] of ["Beta", "Gamma", "Gamma", "Gamma"].entries())
      await expect(variable(index + 1)).toHaveValue(value);
  });
}

for (const orientation of ["Rows", "Columns"] as const) {
  const side = orientation === "Rows" ? "rows" : "columns";
  const title = orientation === "Rows" ? "Row" : "Column";

  test(`${orientation} clone the focused non-last complete Chat history with future-turn images independently`, async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Chat completion", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: orientation, exact: true })
      .selectOption("variable");
    await page.getByLabel("Message 1", { exact: true }).fill("Source question");
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await page.getByLabel("Message 3", { exact: true }).fill("Future question");
    await page
      .getByLabel("Add images to message 3", { exact: true })
      .setInputFiles({
        name: "future.png",
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      page.getByRole("img", { name: "future.png", exact: true }),
    ).toBeVisible();
    await defineCases(page, "chat history");
    await page.getByRole("button", { name: "new case", exact: true }).click();
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const history = (index: number) =>
      table.getByRole("group", {
        name: `${title} case ${index} Chat history`,
        exact: true,
      });
    await history(2)
      .getByLabel("Message 1", { exact: true })
      .fill("Other question");
    const otherFutureMessage = history(2)
      .locator(".deletable-input")
      .filter({ has: page.getByLabel("Message 3", { exact: true }) });
    await otherFutureMessage.hover();
    await otherFutureMessage
      .getByRole("button", { name: "Remove message 3", exact: true })
      .click();
    await expect(
      history(2).getByLabel("Message 3", { exact: true }),
    ).toHaveCount(0);
    await history(2)
      .getByRole("button", { name: "Message 1 role: user", exact: true })
      .click();
    const before = await savedInput(page);
    expect(before[side][0].input).toHaveLength(3);
    expect(before[side][0].input![1]).toEqual({
      role: "unfilled",
      content: "",
    });
    expect(before[side][1].input).toHaveLength(2);

    await history(1).getByLabel("Message 1", { exact: true }).focus();
    await page.getByRole("button", { name: "new case", exact: true }).click();
    await expect(
      history(3).getByLabel("Message 3", { exact: true }),
    ).toHaveValue("Future question");
    await expect(
      history(3).getByRole("button", {
        name: "Message 2 role: unfilled",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      history(3).getByRole("img", { name: "future.png", exact: true }),
    ).toBeVisible();
    const copied = await savedInput(page);
    expect(copied[side].slice(0, 2)).toEqual(before[side]);
    expect(copied[side][2].input).toEqual(before[side][0].input);
    expect(before[side].map(({ id }) => id)).not.toContain(copied[side][2].id);
    await history(3)
      .getByLabel("Message 1", { exact: true })
      .fill("Independent copy");
    await history(3)
      .getByRole("button", {
        name: "Remove future.png from message 3",
        exact: true,
      })
      .click();
    await history(3)
      .getByRole("button", { name: "Message 1 role: user", exact: true })
      .click();
    const edited = await savedInput(page);
    expect(edited[side].slice(0, 2)).toEqual(before[side]);
    expect(edited[side][2].input![0]).toEqual({
      role: "assistant",
      content: "Independent copy",
    });
    expect(edited[side][2].input![2].images ?? []).toEqual([]);
    await expect(
      history(1).getByRole("img", { name: "future.png", exact: true }),
    ).toBeVisible();
    await page.reload();
    expect(await savedInput(page)).toEqual(edited);
    await expect(
      history(3).getByLabel("Message 1", { exact: true }),
    ).toHaveValue("Independent copy");
  });
}
