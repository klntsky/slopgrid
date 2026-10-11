import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

for (const width of [1280, 390]) {
  test(`axis swap preserves values and prompt variables at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    const rows = page.getByRole("combobox", { name: "Rows", exact: true });
    const columns = page.getByRole("combobox", {
      name: "Columns",
      exact: true,
    });
    await rows.selectOption("variable");
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
    await prompt.fill("Draw $VARIABLE_ROW");
    const swap = page.getByRole("button", { name: "Swap rows and columns" });
    const rowBox = (await rows.boundingBox())!;
    const columnBox = (await columns.boundingBox())!;
    const swapBox = (await swap.boundingBox())!;
    if (width > 700) {
      expect(swapBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
      expect(swapBox.x + swapBox.width).toBeLessThanOrEqual(columnBox.x);
    } else {
      expect(swapBox.y).toBeGreaterThan(rowBox.y);
      expect(swapBox.y + swapBox.height).toBeLessThanOrEqual(columnBox.y);
    }
    await swap.click();
    await expect(rows).toHaveValue("effort");
    await expect(columns).toHaveValue("variable");
    await expect(
      page.getByRole("group", { name: "Row values" }).locator("input:checked"),
    ).toHaveCount(2);
    await expect(page.getByLabel("Column values")).toHaveValue("cat\ndog");
    await expect(prompt).toHaveValue("Draw $VARIABLE_COLUMN");
    await swap.click();
    await expect(rows).toHaveValue("variable");
    await expect(columns).toHaveValue("effort");
    await expect(page.getByLabel("Row values")).toHaveValue("cat\ndog");
    await expect(prompt).toHaveValue("Draw $VARIABLE_ROW");
    await page.reload();
    await expect(page.getByLabel("Row values")).toHaveValue("cat\ndog");
    await expect(prompt).toHaveValue("Draw $VARIABLE_ROW");
  });
}

test("model choices start empty and filtering preserves deliberate selections", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Create your own visual AI model benchmark",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  const columns = page.getByRole("group", { name: "Column values" });
  await expect(columns.locator("label.checkbox")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  const filter = page.getByLabel("Search models");
  const clear = page.getByRole("button", { name: "Clear column model filter" });
  await clear.click();
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");
  await expect(page.getByText("Row values", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Search models", { exact: true })).toHaveCount(0);
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
  expect(
    (await columns.locator(".value-list").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(264);
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

test("unused prompt variables block generation and the API rejects bypasses", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await expect(
    page.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("");
  for (const prompt of ["Draw a cat", "$VARIABLE_ROW", "$VARIABLE_COLUMN"]) {
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await expect(page.getByRole("alert")).toContainText("Include $VARIABLE_");
  }
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("$VARIABLE_ROW $VARIABLE_COLUMN");
  const connect = page.getByRole("link", { name: "Connect OpenRouter" });
  await connect.click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("fixture/image");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Prompt", { exact: true }).fill("$VARIABLE_ROW");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  const response = await page.request.post("/api/grids", {
    data: {
      format: "image",
      prompt: "$VARIABLE_ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "variable", values: ["hat"] },
      model: "fixture/image",
      effort: "none",
      budgetUsd: 5,
    },
  });
  expect(response.status()).toBe(400);
  expect(await (await request.get("/fixture/calls")).json()).toEqual([]);
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("$VARIABLE_ROW $VARIABLE_COLUMN");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 4, 4);
});

test("selecting an output type reveals the entire form and preserves it on reload", async ({
  page,
}) => {
  await page.goto("/");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await expect(prompt).toHaveCount(0);
  for (const format of ["SVG", "Markdown", "Static website", "Image"]) {
    await page.getByRole("button", { name: format, exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Rows", exact: true }),
    ).toBeVisible();
    await expect(prompt).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Connect OpenRouter" }),
    ).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /^Continue to/ })).toHaveCount(
    0,
  );
  await prompt.fill("Draw $VARIABLE_ROW");
  await page.reload();
  await expect(prompt).toHaveValue("Draw $VARIABLE_ROW");
  await expect(
    page.getByRole("link", { name: "Connect OpenRouter" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  const model = page.getByRole("checkbox", {
    name: "Fixture image",
    exact: true,
  });
  await model.check();
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
  const rows = page.getByRole("group", { name: "Row values" });
  await rows.getByRole("checkbox", { name: "None", exact: true }).check();
  await rows.getByRole("checkbox", { name: "max", exact: true }).check();
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
    "Model",
    "None",
    "high",
    "max",
  ]);
  const limited = table.getByRole("row", { name: /Second model/ });
  await expect(
    limited
      .getByRole("cell", { name: "None: Unsupported", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await expect(
    limited
      .getByRole("cell", { name: "high: Supported", exact: true })
      .locator("svg"),
  ).toHaveCount(1);
  await expect(
    limited
      .getByRole("cell", { name: "max: Unsupported", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await expect(
    table.getByRole("row", { name: /Fixture text/ }).locator("svg"),
  ).toHaveCount(3);
  await expect(
    page.getByText("These model settings are incompatible:"),
  ).toHaveCount(0);
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
    const values = page.getByRole("group", {
      name: axis === "Rows" ? "Row values" : "Column values",
    });
    await expect(values.locator("label.checkbox")).toHaveText([
      "Model default",
      "None",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
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

test("a per-cell dollar budget defaults to five, changes the model token limit, and survives Edit", async ({
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
    await expect(budget).toHaveValue("5");
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
