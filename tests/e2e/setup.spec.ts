import { test, expect } from "./fixtures";
import {
  create,
  expectProgress,
  finishPublishing,
  selectModel,
} from "./helpers";

test("axis swap preserves selections and substitutes the corresponding prompt variables", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const columns = page.getByRole("combobox", {
    name: "Columns",
    exact: true,
  });
  await rows.selectOption("variable");
  await expect(page.getByLabel("Row values")).toHaveValue("");
  await page.getByLabel("Row values").fill("cat\ndog");
  await columns.selectOption("effort");
  const columnValues = page.getByRole("group", { name: "Column values" });
  await columnValues
    .getByRole("checkbox", { name: "None", exact: true })
    .check();
  await columnValues
    .getByRole("checkbox", { name: "high", exact: true })
    .check();
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("Draw $ROW");
  const swap = page.getByRole("button", { name: "Swap rows and columns" });
  await swap.click();
  await expect(rows).toHaveValue("effort");
  await expect(columns).toHaveValue("variable");
  await expect(
    page.getByRole("group", { name: "Row values" }).locator("input:checked"),
  ).toHaveCount(2);
  await expect(page.getByLabel("Column values")).toHaveValue("cat\ndog");
  await expect(prompt).toHaveValue("Draw $COLUMN");
  await swap.click();
  await expect(rows).toHaveValue("variable");
  await expect(columns).toHaveValue("effort");
  await expect(page.getByLabel("Row values")).toHaveValue("cat\ndog");
  await expect(prompt).toHaveValue("Draw $ROW");
  await page.reload();
  await expect(page.getByLabel("Row values")).toHaveValue("cat\ndog");
  await expect(prompt).toHaveValue("Draw $ROW");
});

test("model choices start empty and filtering preserves deliberate selections", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  const columns = page.getByRole("group", { name: "Column values" });
  const filter = page.getByLabel("Search models");
  const clear = page.getByRole("button", { name: "Clear column model filter" });
  await clear.click();
  await expect(columns.locator("label.checkbox")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");
  await columns
    .getByRole("checkbox", { name: "Fixture text", exact: true })
    .check();
  await page.getByLabel("Search models").fill("FIXTURE/OTHER");
  await expect(columns.getByRole("checkbox")).toHaveCount(1);
  await columns.getByRole("checkbox", { name: "Second model" }).check();
  await page.getByLabel("Search models").fill("no matching model");
  await expect(columns.getByText("No models match your filter.")).toBeVisible();
  const selectedModels = columns.getByRole("list", {
    name: "Selected column models",
  });
  await expect(selectedModels.getByRole("listitem")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  await selectedModels
    .getByRole("button", { name: "Remove Fixture text from columns" })
    .click();
  await expect(selectedModels.getByRole("listitem")).toHaveText([
    "Second model",
  ]);
  await expect(columns.getByText("No models match your filter.")).toBeVisible();
  await clear.click();
  await expect(filter).toHaveValue("");
  await expect(filter).toBeFocused();
  await expect(
    columns.getByRole("checkbox", { name: "Fixture text", exact: true }),
  ).not.toBeChecked();
  await expect(
    columns.getByRole("checkbox", { name: "Second model" }),
  ).toBeChecked();
  await selectedModels
    .getByRole("button", { name: "Remove Second model from columns" })
    .press("Enter");
  await expect(
    columns.getByRole("checkbox", { name: "Second model" }),
  ).not.toBeChecked();
  await expect(selectedModels).toHaveCount(0);
  for (const kind of ["model", "effort"]) {
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption(kind);
    await expect(
      page.getByRole("group", { name: "Row values" }).locator("input:checked"),
    ).toHaveCount(0);
    if (kind === "model") {
      const rowFilter = page
        .getByRole("group", { name: "Row values" })
        .getByLabel("Search models");
      const rowClear = page.getByRole("button", {
        name: "Clear row model filter",
      });
      await rowFilter.fill("no matching model");
      await rowClear.press("Enter");
      await expect(rowFilter).toHaveValue("");
      await expect(rowFilter).toBeFocused();
      await expect(
        page.getByRole("group", { name: "Row values" }).getByRole("checkbox"),
      ).toHaveCount(2);
      const rowModels = page.getByRole("group", { name: "Row values" });
      await rowModels
        .getByRole("checkbox", { name: "Fixture text", exact: true })
        .check();
      await rowModels
        .getByRole("button", { name: "Remove Fixture text from rows" })
        .click();
      await expect(
        rowModels.getByRole("checkbox", { name: "Fixture text", exact: true }),
      ).not.toBeChecked();
    }
  }
});

test("Shift-click selects and clears visible model ranges while preserving hidden selections and drafts", async ({
  page,
}) => {
  const names = ["A even", "B odd", "C even", "D odd", "E even", "F odd"];
  await page.route("**/api/models", async (route) => {
    const response = await route.fetch();
    const [model] = await response.json();
    await route.fulfill({
      json: names.map((name, index) => ({
        ...model,
        id: `range/${index}`,
        name,
        text: true,
        image: false,
      })),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  const columns = page.getByRole("group", { name: "Column values" });
  const box = (index: number) =>
    columns.getByRole("checkbox", { name: names[index], exact: true });
  const selected = columns.locator("label.checkbox:has(input:checked)");
  await box(1).click();
  await columns
    .getByText(names[4], { exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(selected).toHaveText(names.slice(1, 5));
  await box(3).click();
  await box(1).click({ modifiers: ["Shift"] });
  await expect(selected).toHaveText([names[4]]);
  await box(5).click();
  await box(0).click();
  await page.getByLabel("Search models").fill("even");
  await box(2).click({ modifiers: ["Shift"] });
  await expect(selected).toHaveText([names[0], names[2], names[4]]);
  await box(4).click({ modifiers: ["Shift"] });
  await expect(selected).toHaveText([names[0]]);
  await page.getByLabel("Search models").fill("odd");
  await box(1).click({ modifiers: ["Shift"] });
  await expect(selected).toHaveText([names[1], names[5]]);
  await box(1).press("Space");
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  await expect(selected).toHaveText([names[0], names[5]]);
  await page.reload();
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  await expect(selected).toHaveText([names[0], names[5]]);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("model");
  await page.getByRole("button", { name: "Clear row model filter" }).click();
  const rows = page.getByRole("group", { name: "Row values" });
  await rows.getByRole("checkbox", { name: names[0], exact: true }).click();
  await rows
    .getByRole("checkbox", { name: names[2], exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(rows.locator("label.checkbox:has(input:checked)")).toHaveText(
    names.slice(0, 3),
  );
  await expect(selected).toHaveText([names[0], names[5]]);
});

test("unused prompt variables block generation and the API rejects bypasses", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await expect(
    page
      .getByRole("radiogroup", { name: "Model", exact: true })
      .locator("input:checked"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Row values")).toHaveValue("");
  await expect(page.getByLabel("Column values")).toHaveValue("");
  await page.getByLabel("Row values").fill("cat\ndog");
  await page.getByLabel("Column values").fill("hat\ncape");
  for (const prompt of ["Draw a cat", "$ROW", "$COLUMN"]) {
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await expect(page.getByRole("alert")).toBeVisible();
  }
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW $COLUMN");
  const connect = page.getByRole("link", { name: "Connect OpenRouter" });
  await connect.click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await selectModel(page, "fixture/image");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  const response = await page.request.post("/api/grids", {
    data: {
      format: "image",
      prompt: "$ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "variable", values: ["hat"] },
      model: "fixture/image",
      effort: "none",
      budgetUsd: 5,
    },
  });
  expect(response.status()).toBe(400);
  expect(await (await request.get("/fixture/calls")).json()).toEqual([]);
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW $COLUMN");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 4, 4);
});

test("selecting an output type reveals the entire form and preserves it on reload", async ({
  page,
}) => {
  await page.goto("/");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await expect(prompt).toHaveCount(0);
  for (const format of [
    "Image",
    "SVG",
    "Markdown",
    "Static website",
    "Image",
  ]) {
    await page.getByRole("button", { name: format, exact: true }).click();
    const filter = page.getByLabel("Search models");
    if (format === "Image")
      await expect(
        page.getByRole("checkbox", { name: "Fixture image", exact: true }),
      ).toBeVisible();
    await filter.fill("custom filter");
    await expect(
      page.getByRole("combobox", { name: "Rows", exact: true }),
    ).toBeVisible();
    await expect(prompt).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Connect OpenRouter" }),
    ).toBeVisible();
  }
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await prompt.fill("Draw $ROW");
  await page.reload();
  await expect(prompt).toHaveValue("Draw $ROW");
  await expect(
    page.getByRole("link", { name: "Connect OpenRouter" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  const model = page.getByRole("checkbox", {
    name: "Fixture image",
    exact: true,
  });
  await model.check();
  await expect(generate).toBeDisabled();
  await page.getByLabel("Row values").fill("cat\ndog");
  await expect(generate).toBeEnabled();
  await model.uncheck();
  await expect(generate).toBeDisabled();
});

test("the compatibility table shows selected model support without blocking generation or resume", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.47" });
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  const rows = page.getByRole("group", { name: "Row values" });
  await rows.getByRole("checkbox", { name: "None", exact: true }).check();
  await rows.getByRole("checkbox", { name: "max", exact: true }).check();
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  await page
    .getByRole("group", { name: "Column values" })
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  await rows.getByRole("checkbox", { name: "high", exact: true }).check();
  await page
    .getByRole("group", { name: "Column values" })
    .getByRole("checkbox", { name: "Fixture text", exact: true })
    .check();
  const table = page.getByRole("table", {
    name: "Thinking effort compatibility",
  });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Thinking effort",
    "Second model",
    "Fixture text",
  ]);
  await expect(table.getByRole("rowheader")).toHaveText([
    "None",
    "high",
    "max",
  ]);
  const expectedSupport = [
    "None: Unsupported",
    "None: Supported",
    "high: Supported",
    "high: Supported",
    "max: Unsupported",
    "max: Supported",
  ];
  for (const [index, status] of expectedSupport.entries())
    await expect(table.getByRole("cell").nth(index)).toHaveAccessibleName(
      status,
    );
  await rows.getByRole("checkbox", { name: "None", exact: true }).uncheck();
  await expect(table).toBeVisible();
  await rows.getByRole("checkbox", { name: "max", exact: true }).uncheck();
  await expect(table).toHaveCount(0);
  await rows.getByRole("checkbox", { name: "None", exact: true }).check();
  await rows.getByRole("checkbox", { name: "max", exact: true }).check();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Model",
    "None",
    "high",
    "max",
  ]);
  await expect(table.getByRole("rowheader")).toHaveText([
    "Second model",
    "Fixture text",
  ]);
  for (const [index, status] of [
    "None: Unsupported",
    "high: Supported",
    "max: Unsupported",
    "None: Supported",
    "high: Supported",
    "max: Supported",
  ].entries())
    await expect(table.getByRole("cell").nth(index)).toHaveAccessibleName(
      status,
    );
  await page.getByRole("button", { name: "Clear row model filter" }).click();
  const secondModel = page
    .getByRole("group", { name: "Row values" })
    .getByRole("checkbox", { name: "Second model", exact: true });
  await secondModel.uncheck();
  await expect(table).toHaveCount(0);
  await secondModel.check();
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
  await expect(table).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 6, 6);
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    const input = {
      format: "svg",
      prompt: "Draw a cat",
      rows: { kind: "effort", values: ["none", "max"] },
      columns: { kind: "model", values: ["fixture/other"] },
      model: "fixture/text",
      effort: "default",
      budgetUsd: 5,
    };
    const created = await page.request.post("/api/grids", { data: input });
    expect(created.status()).toBe(201);
    const grid = await created.json();
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    expect(
      (await page.request.post(`/api/grids/${grid.id}/pause`)).status(),
    ).toBe(200);
    expect(
      (await page.request.post(`/api/grids/${grid.id}/retry`)).status(),
    ).toBe(200);
    await expect
      .poll(
        async () => (await (await request.get("/fixture/calls")).json()).length,
      )
      .toBe(4);
    await request.post("/fixture/release", { data: { all: true } });
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/grids/${grid.id}`)).json())
            .status,
      )
      .toBe("complete");
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("compatibility follows prompt-variable axes and fixed model or effort settings", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const swap = page.getByRole("button", { name: "Swap rows and columns" });
  const table = page.getByRole("table", {
    name: "Thinking effort compatibility",
  });
  await rows.selectOption("variable");
  await page.getByLabel("Row values").fill("cat\ndog\nfox");
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  await page
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  await expect(table).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Thinking effort", exact: true })
    .selectOption("none");
  await expect(table.getByRole("rowheader")).toHaveText(["cat", "dog", "fox"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Prompt variable",
    "Second model",
  ]);
  await expect(
    table.getByRole("cell", { name: "None: Unsupported", exact: true }),
  ).toHaveCount(3);
  await swap.click();
  await expect(table.getByRole("rowheader")).toHaveText(["Second model"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Model",
    "cat",
    "dog",
    "fox",
  ]);
  await rows.selectOption("effort");
  await page.getByRole("checkbox", { name: "None", exact: true }).check();
  await page.getByRole("checkbox", { name: "high", exact: true }).check();
  await expect(table).toHaveCount(0);
  await selectModel(page, "fixture/other");
  await expect(table.getByRole("rowheader")).toHaveText(["None", "high"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Thinking effort",
    "cat",
    "dog",
    "fox",
  ]);
  await expect(
    table.getByRole("cell", { name: "None: Unsupported", exact: true }),
  ).toHaveCount(3);
  await expect(
    table.getByRole("cell", { name: "high: Supported", exact: true }),
  ).toHaveCount(3);
  await swap.click();
  await expect(table.getByRole("rowheader")).toHaveText(["cat", "dog", "fox"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Prompt variable",
    "None",
    "high",
  ]);
  await selectModel(page, "fixture/text");
  await expect(table).toHaveCount(0);
});

for (const axis of ["Rows", "Columns"] as const) {
  test(`thinking effort ${axis.toLowerCase()} follow effort order regardless of selection sequence`, async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": axis === "Rows" ? "192.0.2.48" : "192.0.2.49",
    });
    await request.post("/fixture/reset", { data: { billing: false } });
    await create(page, "SVG", "cat", "hat");
    await expectProgress(page, 1, 1);
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    await page
      .getByRole("combobox", { name: axis, exact: true })
      .selectOption("effort");
    const other = axis === "Rows" ? "Columns" : "Rows";
    await page
      .getByRole("combobox", { name: other, exact: true })
      .selectOption("model");
    await page.getByLabel("Search models").fill("");
    const values = page.getByRole("group", {
      name: axis === "Rows" ? "Row values" : "Column values",
    });
    for (const effort of ["max", "high", "low"])
      await values.getByRole("checkbox", { name: effort, exact: true }).check();
    await values.getByRole("checkbox", { name: "high", exact: true }).uncheck();
    await values.getByRole("checkbox", { name: "high", exact: true }).check();
    await page
      .getByRole("group", {
        name: other === "Rows" ? "Row values" : "Column values",
      })
      .getByRole("checkbox", { name: "Fixture text", exact: true })
      .check();
    await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 3, 3);
    const labels =
      axis === "Rows"
        ? page.getByRole("rowheader")
        : page.getByRole("columnheader").filter({ hasText: /\S/ });
    await expect(labels).toHaveText(["low", "high", "max"]);
    await page.reload();
    await expect(labels).toHaveText(["low", "high", "max"]);
  });
}

test("changing the per-cell budget changes the model token limit and survives Edit", async ({
  page,
  request,
}) => {
  await page.route("**/api/grids", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "X-Forwarded-For": "192.0.2.62",
      },
    }),
  );
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    await create(page, "Markdown", "cat", "hat");
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/token-limits")).json()).length,
      )
      .toBe(1);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    const budget = page.getByLabel("Budget limit per cell", { exact: true });
    await budget.fill("2");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 0, 1);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/token-limits")).json()).length,
      )
      .toBe(2);
    const limits = await (await request.get("/fixture/token-limits")).json();
    expect(limits.at(-1).max_tokens).toBeLessThan(limits[0].max_tokens);
    expect(limits.at(-1).max_tokens).toBeGreaterThan(0);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(budget).toHaveValue("2");
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("worker recommendation follows grid size, overrides persist, and low-balance continuation honors the request", async ({
  page,
  request,
}) => {
  let submissions = 0;
  await page.route("**/api/grids", (route) => {
    if (route.request().method() === "POST") submissions++;
    return route.continue({
      headers: {
        ...route.request().headers(),
        "X-Forwarded-For": "192.0.2.63",
      },
    });
  });
  await request.post("/fixture/reset", {
    data: { balanceUsd: 6, holdGenerations: true },
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await page.getByLabel("Row values").fill("cat\ndog");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("variable");
    await page.getByLabel("Column values").fill("hat\ncape");
    await selectModel(page, "fixture/text");
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Draw $ROW wearing a $COLUMN");
    await page.getByRole("link", { name: "Connect OpenRouter" }).click();
    const workers = page.getByLabel("# of parallel workers:", { exact: true });
    await expect(workers).toHaveValue("2");
    const max = page.getByRole("button", { name: "MAX", exact: true });
    await page.getByLabel("Row values").fill("cat");
    await page.getByLabel("Column values").fill("hat");
    await expect(workers).toHaveValue("1");
    await page.getByLabel("Row values").fill("cat\ndog");
    await page.getByLabel("Column values").fill("hat\ncape");
    await expect(workers).toHaveValue("2");
    await max.click();
    await expect(workers).toHaveValue("4");
    await workers.fill("1");
    await page.reload();
    await expect(workers).toHaveValue("1");
    await workers.fill("12");
    await expect(workers).toHaveValue("12");
    await workers.press("End");
    await workers.press("Backspace");
    await expect(workers).toHaveValue("1");
    await workers.press("Backspace");
    await expect(workers).toHaveValue("");
    await page.reload();
    await expect(workers).toHaveValue("");
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    for (const value of ["", "0", "-2", "1.5", "abc"]) {
      await workers.fill(value);
      await expect(workers).not.toHaveAttribute("aria-invalid", "true");
      await generate.click();
      await expect(workers).toHaveAttribute("aria-invalid", "true");
      await expect(workers).toHaveValue(value);
    }
    expect(submissions).toBe(0);
    await workers.fill("12");
    await page.getByLabel("Row values").fill("cat");
    await expect(workers).toHaveValue("12");
    await page.getByLabel("Row values").fill("cat\ndog");
    await expect(workers).not.toHaveAttribute("aria-invalid", "true");
    await request.post("/fixture/credits", { data: { balanceUsd: 1 } });
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Continue anyway" })
      .click();
    await expectProgress(page, 0, 4);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    const grid = await (
      await page.request.get(`/api/grids/${page.url().split("/").pop()}`)
    ).json();
    expect(grid.input.parallelWorkers).toBe(12);
    expect(
      grid.cells.filter(
        (cell: { status: string }) => cell.status === "pending",
      ),
    ).toHaveLength(2);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 4, 4);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(workers).toHaveValue("12");
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

for (const format of ["SVG", "Image"]) {
  test(`fixed model radio selector defaults to latest for ${format}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("variable");
    const selector = page.getByRole("radiogroup", {
      name: "Model",
      exact: true,
    });
    const search = selector.getByRole("searchbox");
    await expect(search).toHaveValue("latest");
    await expect(selector.locator("input:checked")).toHaveCount(0);
    await selector
      .getByRole("button", { name: "Clear model filter", exact: true })
      .click();
    const radios = selector.getByRole("radio");
    await radios.nth(0).check();
    const first = await radios.nth(0).inputValue();
    await radios.nth(1).check();
    const second = await radios.nth(1).inputValue();
    expect(second).not.toBe(first);
    await expect(selector.locator("input:checked")).toHaveCount(1);
    await search.fill("no-such-model");
    await expect(
      selector
        .getByRole("list", { name: "Selected model", exact: true })
        .getByRole("listitem"),
    ).toHaveCount(1);
    await page.reload();
    await expect(search).toHaveValue("latest");
    await search.fill(second);
    await expect(selector.locator("input:checked")).toHaveValue(second);
  });
}

test("default image layout generates with automatic quality and preserves edits", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const columns = page.getByRole("combobox", { name: "Columns", exact: true });
  await expect(rows).toHaveValue("model");
  await expect(columns).toHaveValue("quality");
  await expect(
    page.getByRole("group", { name: "Row values" }).locator("input:checked"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Column values" }).locator("input:checked"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: "Auto", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("searchbox", { name: "Search models" }),
  ).toHaveValue("");
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("quality");
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(rows).toHaveValue("model");
  await expect(columns).toHaveValue("quality");
  await expect(
    page.getByRole("checkbox", { name: "Auto", exact: true }),
  ).toBeChecked();
  await columns.selectOption("background");
  await page
    .getByRole("checkbox", { name: "transparent", exact: true })
    .check();
  await page.reload();
  await expect(columns).toHaveValue("background");
  await expect(
    page.getByRole("checkbox", { name: "transparent", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Fixture image", exact: true }),
  ).toBeChecked();
});

for (const format of ["SVG", "Static website"]) {
  test(`default ${format} layout compares models by thinking effort and preserves edits`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: {} });
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    const rows = page.getByRole("combobox", { name: "Rows", exact: true });
    const columns = page.getByRole("combobox", {
      name: "Columns",
      exact: true,
    });
    await expect(rows).toHaveValue("model");
    await expect(columns).toHaveValue("effort");
    await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(
      page.getByRole("searchbox", { name: "Search models" }),
    ).toHaveValue("latest");
    await page.getByRole("button", { name: "Clear row model filter" }).click();
    await page
      .getByRole("checkbox", { name: "Fixture text", exact: true })
      .check();
    await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
    await page.getByRole("link", { name: "Connect OpenRouter" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate", exact: true }),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "None", exact: true }).check();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 1, 1);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(rows).toHaveValue("model");
    await expect(columns).toHaveValue("effort");
    await expect(
      page.getByRole("checkbox", { name: "None", exact: true }),
    ).toBeChecked();
    await columns.selectOption("variable");
    await page.getByLabel("Column values").fill("landscape");
    await page.reload();
    await expect(rows).toHaveValue("model");
    await expect(columns).toHaveValue("variable");
    await expect(page.getByLabel("Column values")).toHaveValue("landscape");
  });
}
