import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  connectOpenRouter,
  create,
  expectProgress,
  selectModel,
  mockModels,
  setVariableValues,
} from "./helpers";
import { currentDefinition } from "../current-grid-fixture";

async function acceptDrop(page: Page, action: () => Promise<unknown>) {
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Drop these values?");
    await dialog.accept();
  });
  await action();
}

test("disabled Generate explains blockers on hover and keyboard focus", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  const wrapper = generate.locator("..");
  const tooltip = page.getByRole("tooltip");
  await expect(generate).toBeDisabled();
  await wrapper.hover();
  for (const reason of [
    "Select row values.",
    "Connect OpenRouter.",
    "Enter a prompt.",
  ])
    await expect(tooltip).toContainText(reason);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await setVariableValues(page, "Rows", ["cat"]);
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW1");
  await wrapper.focus();
  await expect(tooltip).toContainText("Select a model.");
  await expect(generate).toBeDisabled();
  await expect(tooltip).not.toContainText("Select row values.");
  await selectModel(page, "fixture/text");
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW1 wearing a hat");
  let releaseCapacity!: () => void;
  const capacityResponse = new Promise<void>((resolve) => {
    releaseCapacity = resolve;
  });
  await page.route("**/api/inference-capacity?*", async (route) => {
    await capacityResponse;
    await route.fulfill({
      status: 503,
      json: { error: "Balance unavailable" },
    });
  });
  await connectOpenRouter(page);
  await wrapper.hover();
  await expect(tooltip).toHaveText("Checking the automatic worker count.");
  releaseCapacity();
  await expect(
    page.getByRole("button", { name: "Check balance again" }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await wrapper.hover();
  await expect(tooltip).toHaveText(
    "Could not determine the automatic worker count.",
  );
  await page.unroute("**/api/inference-capacity?*");
  await page.getByRole("button", { name: "Check balance again" }).click();
  await expect(generate).toBeEnabled();
  await generate.focus();
  await wrapper.hover();
  await expect(tooltip).toHaveCount(0);
  await page.getByLabel("Budget limit per cell").fill("0");
  await expect(generate).toBeDisabled();
  await wrapper.focus();
  await expect(
    page.getByRole("tooltip", {
      name: "Enter a positive per-cell budget.",
      exact: true,
    }),
  ).toBeVisible();
});

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
  await setVariableValues(page, "Rows", ["cat", "dog"]);
  await columns.selectOption("effort");
  const columnValues = page.getByRole("group", { name: "Column values" });
  await columnValues
    .getByRole("checkbox", { name: "Model default", exact: true })
    .uncheck();
  await columnValues
    .getByRole("checkbox", { name: "None", exact: true })
    .check();
  await columnValues
    .getByRole("checkbox", { name: "high", exact: true })
    .check();
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("Draw $ROW1");
  const swap = page.getByRole("button", { name: "Swap rows and columns" });
  await swap.click();
  await expect(rows).toHaveValue("effort");
  await expect(columns).toHaveValue("variable");
  await expect(
    page.getByRole("group", { name: "Row values" }).locator("input:checked"),
  ).toHaveCount(2);
  await expect(
    page.getByLabel("$COLUMN1, case 1", { exact: true }),
  ).toHaveValue("cat");
  await expect(
    page.getByLabel("$COLUMN1, case 2", { exact: true }),
  ).toHaveValue("dog");
  await expect(prompt).toHaveValue("Draw $COLUMN1");
  await swap.click();
  await expect(rows).toHaveValue("variable");
  await expect(columns).toHaveValue("effort");
  await expect(page.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "cat",
  );
  await expect(page.getByLabel("$ROW1, case 2", { exact: true })).toHaveValue(
    "dog",
  );
  await expect(prompt).toHaveValue("Draw $ROW1");
  await page.reload();
  await expect(page.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "cat",
  );
  await expect(page.getByLabel("$ROW1, case 2", { exact: true })).toHaveValue(
    "dog",
  );
  await expect(prompt).toHaveValue("Draw $ROW1");
});

test("model filtering preserves deliberate selections and supports keyboard removal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  const columns = page.getByRole("group", { name: "Column values" });
  const filter = page.getByLabel("Search models");
  const clear = page.getByRole("button", { name: "Clear column model filter" });
  await clear.click();
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
  await expect(
    page
      .getByRole("combobox", { name: "Rows", exact: true })
      .locator('option[value="model"]'),
  ).toHaveJSProperty("disabled", true);
  await page
    .getByRole("button", { name: "Make model common", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("model");
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
});

test("Shift-click selects and clears visible model ranges while preserving hidden selections and drafts", async ({
  page,
}) => {
  const names = ["A even", "B odd", "C even", "D odd", "E even", "F odd"];
  await mockModels(page, ([model]) =>
    names.map((name, index) => ({
      ...model,
      id: `range/${index}`,
      name,
      text: true,
      image: false,
    })),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
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
  const selected = columns.locator(
    "label.checkbox:has(input:checked) > span:first-of-type",
  );
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
  await acceptDrop(page, () =>
    page
      .getByRole("button", { name: "Make model common", exact: true })
      .click(),
  );
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("model");
  await page.getByRole("button", { name: "Clear row model filter" }).click();
  const rows = page.getByRole("group", { name: "Row values" });
  await rows.getByRole("checkbox", { name: names[0], exact: true }).click();
  await rows
    .getByRole("checkbox", { name: names[2], exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(
    rows.locator("label.checkbox:has(input:checked) > span:first-of-type"),
  ).toHaveText(names.slice(0, 3));
  await expect(
    page.getByRole("radiogroup", { name: "Model", exact: true }),
  ).toHaveCount(0);
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
    .selectOption("quality");
  await setVariableValues(page, "Rows", ["cat", "dog"]);
  const qualities = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await qualities
    .getByRole("checkbox", { name: "Auto", exact: true })
    .uncheck();
  await qualities.getByRole("checkbox", { name: "low", exact: true }).check();
  await qualities.getByRole("checkbox", { name: "high", exact: true }).check();
  for (const prompt of ["Draw a cat", "$COLUMN1"]) {
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await expect(page.getByRole("alert")).toBeVisible();
  }
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW1 wearing a hat");
  const connect = page.getByRole("link", { name: "Connect OpenRouter" });
  await connect.click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await selectModel(page, "fixture/image");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  const response = await page.request.post("/api/grids", {
    data: currentDefinition({
      format: "image",
      prompt: "Draw a cat",
      parameters: { variable: { kind: "rows" } },
      rows: [{ variable: [{ text: "cat" }] }],
      budgetUsd: 5,
    }),
  });
  expect(response.status()).toBe(400);
  await page.getByLabel("Prompt", { exact: true }).fill("$ROW1 wearing a hat");
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
  await prompt.fill("Draw $ROW1");
  await page.reload();
  await expect(prompt).toHaveValue("Draw $ROW1");
  await expect(
    page.getByRole("link", { name: "Connect OpenRouter" }),
  ).toBeVisible();
  await connectOpenRouter(page);
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  const model = page.getByRole("checkbox", {
    name: "Fixture image",
    exact: true,
  });
  await model.check();
  await setVariableValues(page, "Rows", ["cat", "dog"]);
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
  await create(page, { rowValues: ["cat"] });
  await expectProgress(page, 1, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  const rows = page.getByRole("group", { name: "Row values" });
  await rows
    .getByRole("checkbox", { name: "Model default", exact: true })
    .uncheck();
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
    "Model",
    "None",
    "high",
    "max",
  ]);
  await expect(table.getByRole("rowheader")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  const expectedSupport = [
    "Fixture text / None: Supported",
    "Fixture text / high: Supported",
    "Fixture text / max: Supported",
    "Second model / None: Unsupported",
    "Second model / high: Supported",
    "Second model / max: Unsupported",
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
    "Fixture text",
    "Second model",
  ]);
  for (const [index, status] of expectedSupport.entries())
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
    const input = currentDefinition({
      format: "svg",
      prompt: "Draw a cat",
      parameters: { effort: { kind: "rows" }, model: { kind: "columns" } },
      rows: [{ effort: "none" }, { effort: "max" }],
      columns: [{ model: "fixture/other" }],
      budgetUsd: 5,
    });
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

test("compatibility keeps model rows and effort columns with variable axes and fixed selections", async ({
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
  await setVariableValues(page, "Rows", ["cat", "dog", "fox"]);
  await page.getByRole("button", { name: "Clear column model filter" }).click();
  await page
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  await expect(table).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Thinking effort", exact: true })
    .selectOption("none");
  await expect(table.getByRole("rowheader")).toHaveText(["Second model"]);
  await expect(table.getByRole("columnheader")).toHaveText(["Model", "None"]);
  await expect(
    table.getByRole("cell", {
      name: "Second model / None: Unsupported",
      exact: true,
    }),
  ).toHaveCount(1);
  await swap.click();
  await expect(table.getByRole("rowheader")).toHaveText(["Second model"]);
  await expect(table.getByRole("columnheader")).toHaveText(["Model", "None"]);
  await rows.selectOption("effort");
  await page
    .getByRole("checkbox", { name: "Model default", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "None", exact: true }).check();
  await page.getByRole("checkbox", { name: "high", exact: true }).check();
  await expect(table.getByRole("rowheader")).toHaveText(["Second model"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Model",
    "None",
    "high",
  ]);
  await expect(
    table.getByRole("cell", {
      name: "Second model / None: Unsupported",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    table.getByRole("cell", {
      name: "Second model / high: Supported",
      exact: true,
    }),
  ).toHaveCount(1);
  await swap.click();
  await expect(table.getByRole("rowheader")).toHaveText(["Second model"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Model",
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
    await create(page, { rowValues: ["cat"] });
    await expectProgress(page, 1, 1);
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    if (axis === "Rows")
      await page.getByRole("button", { name: "Swap rows and columns" }).click();
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
    await values
      .getByRole("checkbox", { name: "Model default", exact: true })
      .uncheck();
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
    await expect(labels).toHaveText([/\blow$/, /\bhigh$/, /\bmax$/]);
    await page.reload();
    await expect(labels).toHaveText([/\blow$/, /\bhigh$/, /\bmax$/]);
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
    await create(page, { format: "Markdown", rowValues: ["cat"] });
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

for (const format of ["SVG", "Image"]) {
  test(`automatic workers survive stale draft overrides for ${format}`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", {
      data: { balanceUsd: 6, holdGenerations: true },
    });
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption(format === "Image" ? "quality" : "effort");
    await setVariableValues(page, "Rows", ["cat", "dog"]);
    const values = page.getByRole("group", {
      name: "Column values",
      exact: true,
    });
    await values
      .getByRole("checkbox", {
        name: format === "Image" ? "Auto" : "Model default",
        exact: true,
      })
      .uncheck();
    for (const value of format === "Image" ? ["low", "high"] : ["none", "high"])
      await values
        .getByRole("checkbox", {
          name: value === "none" ? "None" : value,
          exact: true,
        })
        .check();
    await selectModel(
      page,
      format === "Image" ? "fixture/image" : "fixture/text",
    );
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("$ROW1 wearing a hat");
    await connectOpenRouter(page);
    await page.evaluate(() => {
      const draft = JSON.parse(sessionStorage.getItem("slopgrid-draft")!);
      draft.workerInput = "invalid";
      draft.input.parallelWorkers = 1;
      sessionStorage.setItem("slopgrid-draft", JSON.stringify(draft));
    });
    await page.reload();
    const sent = page.waitForRequest(
      (r) =>
        r.method() === "POST" && new URL(r.url()).pathname === "/api/grids",
    );
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    expect((await sent).postDataJSON().parallelWorkers).toBe(
      format === "Image" ? 4 : undefined,
    );
    await expectProgress(page, 0, 4);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 4, 4);
  });
}

for (const format of ["SVG", "Image"]) {
  test(`fixed model radio selector preserves the default filter for ${format}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption(format === "Image" ? "quality" : "effort");
    const selector = page.getByRole("radiogroup", {
      name: "Model",
      exact: true,
    });
    const search = selector.getByRole("searchbox");
    const defaultFilter = format === "Image" ? "" : "latest";
    await expect(search).toHaveValue(defaultFilter);
    await expect(selector.locator("input:checked")).toHaveCount(0);
    await selector
      .getByRole("button", { name: "Clear model filter", exact: true })
      .click();
    const radios = selector.getByRole("radio");
    await radios.nth(0).check();
    await radios.nth(1).check();
    const second = await radios.nth(1).inputValue();
    await expect(selector.locator("input:checked")).toHaveCount(1);
    await search.fill("no-such-model");
    await page.reload();
    await expect(search).toHaveValue(defaultFilter);
    await search.fill(second);
    await expect(selector.locator("input:checked")).toHaveValue(second);
  });
}

test("image generation omits automatic quality and preserves edited axes", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const columns = page.getByRole("combobox", { name: "Columns", exact: true });
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
  await connectOpenRouter(page);
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/image-requests")).json();
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

for (const format of ["SVG", "Static website", "Markdown"]) {
  test(`${format} generation preserves thinking-effort and variable-axis edits`, async ({
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
    const modelAxis = format === "Markdown" ? "column" : "row";
    const modelKind = format === "Markdown" ? columns : rows;
    const effortKind = format === "Markdown" ? rows : columns;
    const defaultEffort = page.getByRole("checkbox", {
      name: "Model default",
      exact: true,
    });
    await page
      .getByRole("button", { name: `Clear ${modelAxis} model filter` })
      .click();
    await page
      .getByRole("checkbox", { name: "Fixture text", exact: true })
      .check();
    await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
    await connectOpenRouter(page);
    await expect(
      page.getByRole("button", { name: "Generate", exact: true }),
    ).toBeEnabled();
    await defaultEffort.uncheck();
    await page.getByRole("checkbox", { name: "None", exact: true }).check();
    await page.reload();
    await expect(defaultEffort).not.toBeChecked();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 1, 1);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(modelKind).toHaveValue("model");
    await expect(effortKind).toHaveValue("effort");
    await expect(defaultEffort).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "None", exact: true }),
    ).toBeChecked();
    await effortKind.selectOption("variable");
    const side = format === "Markdown" ? "Rows" : "Columns";
    const variableValues = page.getByLabel(
      format === "Markdown" ? "$ROW1, case 1" : "$COLUMN1, case 1",
      { exact: true },
    );
    await setVariableValues(page, side, ["landscape"]);
    await page.reload();
    await expect(modelKind).toHaveValue("model");
    await expect(effortKind).toHaveValue("variable");
    await expect(variableValues).toHaveValue("landscape");
  });
}

test("incomplete chat, criteria and raw budget survive reload and OAuth before canonical submission", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await setVariableValues(page, "Rows", ["cat"]);
  await selectModel(page, "fixture/text");
  const message = page.getByLabel("Message 1", { exact: true });
  const budget = page.getByLabel("Budget limit per cell", { exact: true });
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await budget.fill("");
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judgeSection = page.getByRole("region", { name: "Judge", exact: true });
  const criterion = judgeSection.getByLabel("Criterion 1", { exact: true });
  await criterion.fill("  ");
  const judge = judgeSection.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await judge.getByRole("searchbox").fill("fixture/text");
  await judge.locator('input[type="radio"][value="fixture/text"]').check();
  await expect(generate).toBeDisabled();
  await page.reload();
  await expect(message).toHaveValue("");
  await expect(criterion).toHaveValue("  ");
  await expect(budget).toHaveValue("");
  await connectOpenRouter(page);
  await expect(message).toHaveValue("");
  await expect(criterion).toHaveValue("  ");
  await expect(budget).toHaveValue("");
  expect(
    await page.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem("slopgrid-draft")!);
      return {
        budget: saved.input.budgetUsd,
        message: saved.input.messages[0].content,
        criterion: saved.input.parameters.judge_criteria.value[0].text,
      };
    }),
  ).toEqual({ budget: "", message: "", criterion: "  " });
  await budget.fill("0.25");
  await expect(generate).toBeDisabled();
  await message.fill("  Draw $ROW1  ");
  await expect(generate).toBeDisabled();
  await criterion.fill("  Is it a cat?  ");
  await expect(generate).toBeEnabled();
  await message.fill("");
  await expect(generate).toBeDisabled();
  await message.fill("  Draw $ROW1  ");
  await budget.fill("");
  await expect(generate).toBeDisabled();
  await budget.fill("0.25");
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/grids",
  );
  await generate.click();
  expect((await sent).postDataJSON().budgetUsd).toBe(0.25);
  await expectProgress(page, 1, 1);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(budget).toHaveValue("0.25");
  await expect(message).toHaveValue("  Draw $ROW1  ");
  await expect(criterion).toHaveValue("Is it a cat?");
});
