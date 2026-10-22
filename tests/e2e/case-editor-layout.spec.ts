import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  mockModels,
  defineCases,
  selectModel,
} from "./helpers";
import { referencePng } from "../reference-image-fixture";

for (const format of ["SVG", "Image"]) {
  test(`${format} keeps ordinary axes outside the case table through variable editing`, async ({
    page,
  }) => {
    const image = format === "Image";
    await mockModels(page, (models) =>
      Array.from({ length: 2 }, (_, index) => ({
        ...models.find(
          (model) => model.id === (image ? "fixture/image" : "fixture/text"),
        )!,
        id: `fixture/layout-${index}`,
        name: `Layout model ${index + 1}`,
      })),
    );
    await page.goto("/");
    await page.getByRole("button", { name: format, exact: true }).click();
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const rows = page.getByRole("combobox", { name: "Rows", exact: true });
    const columns = page.getByRole("combobox", {
      name: "Columns",
      exact: true,
    });
    await expect(rows).toHaveValue("model");
    await expect(columns).toHaveValue(image ? "quality" : "effort");
    await expect(table).toHaveCount(0);
    await expect(
      page
        .getByRole("group", { name: "Row values", exact: true })
        .getByRole("searchbox"),
    ).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Column values", exact: true })
        .getByRole("checkbox")
        .first(),
    ).toBeVisible();

    await rows.selectOption("variable");
    await expect(table).toBeVisible();
    await expect(table.getByRole("textbox")).toHaveCount(0);
    await page
      .getByRole("button", { name: "new variable", exact: true })
      .click();
    await expect(
      table.getByRole("button", { name: "Remove row case 1", exact: true }),
    ).toBeDisabled();

    await columns.selectOption("model");
    await expect(columns).toHaveValue("model");
    const models = page.getByRole("group", {
      name: "Column values",
      exact: true,
    });
    await models.getByRole("searchbox").fill("Layout model");
    await models
      .getByRole("checkbox", { name: "Layout model 1", exact: true })
      .check();
    await models
      .getByRole("checkbox", { name: "Layout model 2", exact: true })
      .check();
    await expect(table.getByRole("searchbox")).toHaveCount(0);
    await expect(table.getByRole("textbox")).toHaveCount(1);

    await page
      .getByRole("button", { name: "new case", exact: true })
      .click();
    await expect(table.getByRole("textbox")).toHaveCount(2);
    await table.getByLabel("$ROW1, case 1", { exact: true }).fill("identical");
    await table.getByLabel("$ROW1, case 2", { exact: true }).fill("identical");
    await expect(table.getByRole("textbox")).toHaveCount(2);
    await table.getByLabel("$ROW1, case 1", { exact: true }).fill("");
    await table.getByLabel("$ROW1, case 2", { exact: true }).fill("");
    await expect(table.getByRole("textbox")).toHaveCount(2);
    await rows.selectOption(image ? "quality" : "effort");
    await expect(table).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Row values", exact: true }),
    ).toBeVisible();
    await expect(models).toBeVisible();
    await page
      .getByRole("button", { name: "Swap rows and columns", exact: true })
      .click();
    await expect(rows).toHaveValue("model");
    await expect(columns).toHaveValue(image ? "quality" : "effort");
    await expect(table).toHaveCount(0);
  });
}

test("a single case keeps field image associations and stable tokens in both orientations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  await page
    .getByRole("button", { name: "new variable", exact: true })
    .click();
  await page
    .getByRole("button", { name: "new variable", exact: true })
    .click();
  await table
    .getByLabel("$ROW1, case 1", { exact: true })
    .fill("discard this field");
  await table
    .getByLabel("$ROW2, case 1", { exact: true })
    .fill("keep this field");
  await table
    .getByLabel("Add images to $ROW2, case 1", { exact: true })
    .setInputFiles({
      name: "associated.png",
      mimeType: "image/png",
      buffer: referencePng,
    });
  await expect(
    table.getByRole("img", { name: "associated.png", exact: true }),
  ).toBeVisible();
  await table
    .getByRole("button", { name: "Remove $ROW1", exact: true })
    .click();
  await expect(table.getByLabel("$ROW1, case 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(table.getByLabel("$ROW2, case 1", { exact: true })).toHaveValue(
    "keep this field",
  );
  await page
    .getByRole("button", { name: "new variable", exact: true })
    .click();
  await expect(table.getByLabel("$ROW3, case 1", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    table.getByRole("img", { name: "associated.png", exact: true }),
  ).toHaveCount(1);
  await expect(
    table
      .getByLabel("$ROW2, case 1", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("img", { name: "associated.png", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await expect(
    table.getByLabel("$COLUMN2, case 1", { exact: true }),
  ).toHaveValue("keep this field");
  await expect(
    table.getByLabel("$COLUMN3, case 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    table
      .getByLabel("$COLUMN2, case 1", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("img", { name: "associated.png", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    table.getByLabel("$COLUMN2, case 1", { exact: true }),
  ).toHaveValue("keep this field");
  await expect(
    table.getByRole("img", { name: "associated.png", exact: true }),
  ).toBeVisible();
});

test("case-owned model and judge controls stay with prompt fields while common judge controls stay in Judge", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  const judge = page.getByRole("region", { name: "Judge", exact: true });
  const defineCriteria = judge.getByRole("button", {
    name: "define multiple cases for judge criteria",
    exact: true,
  });
  await expect(defineCriteria).toBeDisabled();
  await expect(
    judge.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await defineCases(page, "model");
  await defineCases(page, "judge model");
  await defineCases(page, "judge thinking effort");
  await defineCases(page, "judge criteria");
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  await expect(table).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "new variable", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("group", { name: "Row case 1 Model", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("group", { name: "Row case 1 Judge model", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("combobox", { name: "Judge thinking effort", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("group", {
      name: "Row case 1 judge criteria",
      exact: true,
    }),
  ).toBeVisible();
  await expect(judge.getByLabel("Criterion 1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Column values", exact: true }),
  ).toBeVisible();
  await table
    .getByRole("button", { name: "Make judge criteria common", exact: true })
    .click();
  await expect(judge.getByLabel("Criterion 1", { exact: true })).toBeVisible();
  await expect(
    table.getByRole("group", {
      name: "Row case 1 judge criteria",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("an empty restored case list hides only the table and can return to one editable case", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("button", { name: "new variable", exact: true })
    .click();
  await page
    .getByLabel("$ROW1, case 1", { exact: true })
    .fill("unfinished question");
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem("slopgrid-draft")!);
    saved.input.rows = [];
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(saved));
  });
  await page.reload();
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  await expect(table).toHaveCount(0);
  await expect(page.locator(".variable-editor").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("variable");
  await expect(
    page.getByRole("group", { name: "Column values", exact: true }),
  ).toBeVisible();
  const definePrompt = page.getByRole("button", {
    name: "define multiple cases for prompt",
    exact: true,
  });
  await expect(definePrompt).toBeDisabled();
  await page.getByRole("button", { name: "new case", exact: true }).click();
  await expect(table).toBeVisible();
  await expect(definePrompt).toBeEnabled();
  await page
    .getByRole("button", { name: "new variable", exact: true })
    .click();
  await table
    .getByLabel("$ROW1, case 1", { exact: true })
    .fill("restored question");
  await page.reload();
  await expect(table.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "restored question",
  );
});

for (const side of ["Rows", "Columns"] as const) {
  test(`${side} variable cases can be cancelled or returned to a single-cell grid`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    const axis = page.getByRole("combobox", { name: side, exact: true });
    const other = page.getByRole("combobox", {
      name: side === "Rows" ? "Columns" : "Rows",
      exact: true,
    });
    await axis.selectOption("variable");
    await other.selectOption("single");
    const commonModel = page.getByRole("radiogroup", {
      name: "Model",
      exact: true,
    });
    await commonModel.getByRole("searchbox").fill("fixture/text");
    await commonModel
      .locator('input[type="radio"][value="fixture/text"]')
      .check();
    await page
      .getByRole("combobox", { name: "Thinking effort", exact: true })
      .selectOption("high");
    const token = side === "Rows" ? "$ROW1" : "$COLUMN1";
    await defineCases(page, "model");
    await defineCases(page, "thinking effort");
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    await page
      .getByRole("button", { name: "new variable", exact: true })
      .click();
    await table.getByLabel(`${token}, case 1`, { exact: true }).fill("Alpha");
    await page
      .getByRole("button", { name: "new case", exact: true })
      .click();
    await table.getByLabel(`${token}, case 2`, { exact: true }).fill("Beta");
    const secondModel = table.getByRole("group", {
      name: `${side === "Rows" ? "Row" : "Column"} case 2 Model`,
      exact: true,
    });
    await secondModel.getByRole("searchbox").fill("fixture/text");
    await secondModel
      .locator('input[type="radio"][value="fixture/text"]')
      .check();
    await table
      .getByRole("combobox", { name: "Thinking effort", exact: true })
      .nth(1)
      .selectOption("low");
    const prompt = page.getByLabel("Prompt", { exact: true });
    await prompt.fill(`Draw ${token}`);
    await connectOpenRouter(page);
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await expect(generate).toBeEnabled();

    const cancellation = page.waitForEvent("dialog");
    const cancelledSelection = axis.selectOption("single");
    await (await cancellation).dismiss();
    await cancelledSelection;
    await expect(axis).toHaveValue("variable");
    await page.reload();
    await expect(
      table.getByLabel(`${token}, case 1`, { exact: true }),
    ).toHaveValue("Alpha");
    await expect(
      table.getByLabel(`${token}, case 2`, { exact: true }),
    ).toHaveValue("Beta");
    await secondModel.getByRole("searchbox").fill("fixture/text");
    await expect(
      secondModel.locator('input[type="radio"][value="fixture/text"]'),
    ).toBeChecked();
    await expect(
      table
        .getByRole("combobox", { name: "Thinking effort", exact: true })
        .nth(1),
    ).toHaveValue("low");

    const confirmation = page.waitForEvent("dialog");
    const acceptedSelection = axis.selectOption("single");
    await (await confirmation).accept();
    await acceptedSelection;
    await expect(axis).toHaveValue("single");
    await expect(other).toHaveValue("single");
    await expect(table).toHaveCount(0);
    await commonModel.getByRole("searchbox").fill("fixture/text");
    await expect(
      commonModel.locator('input[type="radio"][value="fixture/text"]'),
    ).toBeChecked();
    await expect(
      page.getByRole("combobox", { name: "Thinking effort", exact: true }),
    ).toHaveValue("default");
    await expect(prompt).toHaveValue(`Draw ${token}`);
    await expect(generate).toBeDisabled();
    await prompt.fill("Draw a rectangle");
    await expect(generate).toBeEnabled();
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/grids",
    );
    await generate.click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    await expectProgress(page, 1, 1);
    const grid = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(grid.input.rows).toHaveLength(1);
    expect(grid.input.columns).toHaveLength(1);
    expect(grid.input.parameters.variable).toBeUndefined();
    expect(
      grid.cells.map(
        (cell: { model: string; effort: string; prompt: string }) => [
          cell.model,
          cell.effort,
          cell.prompt,
        ],
      ),
    ).toEqual([["fixture/text", "default", "Draw a rectangle"]]);
  });
}

for (const side of ["Rows", "Columns"] as const) {
  test(`${side} own complete prompts without numbered fields and preserve promotion, cancellation, swap and reload`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    const title = side === "Rows" ? "Row" : "Column";
    const opposite = side === "Rows" ? "Columns" : "Rows";
    const oppositeTitle = side === "Rows" ? "Column" : "Row";
    const axis = page.getByRole("combobox", { name: side, exact: true });
    await axis.selectOption("variable");
    await page
      .getByRole("combobox", { name: opposite, exact: true })
      .selectOption("single");
    await selectModel(page, "fixture/text");
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    await expect(table.getByRole("textbox")).toHaveCount(0);
    await page
      .getByRole("button", { name: "new case", exact: true })
      .click();
    const common = page.getByLabel("Prompt", { exact: true });
    await common.fill("Draw a complete blue landscape");
    await page
      .getByLabel("Add images to prompt", { exact: true })
      .setInputFiles({
        name: "complete.png",
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      page.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    await defineCases(page, "prompt");
    const first = table.getByRole("group", {
      name: `${title} case 1 Prompt`,
      exact: true,
    });
    await expect(first.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw a complete blue landscape",
    );
    await expect(
      first.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    const second = table.getByRole("group", {
      name: `${title} case 2 Prompt`,
      exact: true,
    });
    await expect(second.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw a complete blue landscape",
    );
    await expect(
      second.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(2);
    await table
      .getByRole("button", { name: "Make prompt common", exact: true })
      .click();
    await expect(common).toHaveValue("Draw a complete blue landscape");
    await expect(
      page.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    await defineCases(page, "prompt");
    await second
      .getByLabel("Prompt", { exact: true })
      .fill("Paint a distinct red portrait");
    const snapshot = () =>
      page.evaluate(
        () => JSON.parse(sessionStorage.getItem("slopgrid-draft")!).input,
      );
    const before = await snapshot();
    expect(before.caseAxis).toBe(side.toLowerCase());
    expect(before.parameters.input).toEqual({ kind: side.toLowerCase() });
    expect(before.parameters.variable).toBeUndefined();
    for (const record of before[side.toLowerCase()])
      expect(record.variable).toBeUndefined();
    for (const action of [
      () =>
        table
          .getByRole("button", {
            name: "Make prompt common",
            exact: true,
          })
          .click(),
      () => axis.selectOption("single"),
    ]) {
      const dialog = page.waitForEvent("dialog");
      const pending = action();
      await (await dialog).dismiss();
      await pending;
      expect(await snapshot()).toEqual(before);
    }
    await page.reload();
    await expect(second.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Paint a distinct red portrait",
    );
    await expect(
      first.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Swap rows and columns", exact: true })
      .click();
    const swapped = table.getByRole("group", {
      name: `${oppositeTitle} case 1 Prompt`,
      exact: true,
    });
    await expect(swapped.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw a complete blue landscape",
    );
    await expect(
      swapped.getByRole("img", { name: "complete.png", exact: true }),
    ).toBeVisible();
    const afterSwap = await snapshot();
    expect(afterSwap[opposite.toLowerCase()]).toEqual(
      before[side.toLowerCase()],
    );
    await connectOpenRouter(page);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/grids",
    );
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    await expectProgress(page, 2, 2);
    const grid = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(grid.input.inputVersion).toBe(3);
    expect(grid.input.parameters.variable).toBeUndefined();
    expect(grid.cells.map((cell: { prompt: string }) => cell.prompt)).toEqual([
      "Draw a complete blue landscape",
      "Paint a distinct red portrait",
    ]);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    const confirmation = page.waitForEvent("dialog");
    const demote = table
      .getByRole("button", { name: "Make prompt common", exact: true })
      .click();
    await (await confirmation).accept();
    await demote;
    await expect(common).toHaveValue("");
    await expect(
      page.getByRole("img", { name: "complete.png", exact: true }),
    ).toHaveCount(0);
  });
}

for (const side of ["Rows", "Columns"] as const) {
  test(`${side} keep structurally distinct full chat histories, user attachments and empty field history`, async ({
    page,
  }) => {
    await page.request.post("/fixture/reset", { data: {} });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Chat completion", exact: true })
      .click();
    const title = side === "Rows" ? "Row" : "Column";
    await page
      .getByRole("combobox", { name: side, exact: true })
      .selectOption("variable");
    await page
      .getByRole("combobox", {
        name: side === "Rows" ? "Columns" : "Rows",
        exact: true,
      })
      .selectOption("single");
    await selectModel(page, "fixture/text");
    await page
      .getByLabel("Message 1", { exact: true })
      .fill("First complete question");
    await page
      .getByLabel("Add images to message 1", { exact: true })
      .setInputFiles({
        name: "history.png",
        mimeType: "image/png",
        buffer: referencePng,
      });
    await expect(
      page.getByRole("img", { name: "history.png", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await defineCases(page, "chat history");
    const table = page.getByRole("table", {
      name: "Grid layout parameters",
      exact: true,
    });
    const first = table.getByRole("group", {
      name: `${title} case 1 Chat history`,
      exact: true,
    });
    await expect(
      first.getByRole("button", {
        name: "Message 2 role: unfilled",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      first.getByRole("img", { name: "history.png", exact: true }),
    ).toBeVisible();
    await table
      .getByRole("button", { name: "Make chat history common", exact: true })
      .click();
    await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue(
      "First complete question",
    );
    await expect(
      page.getByRole("button", {
        name: "Message 2 role: unfilled",
        exact: true,
      }),
    ).toBeVisible();
    await defineCases(page, "chat history");
    await page
      .getByRole("button", { name: "new case", exact: true })
      .click();
    const second = table.getByRole("group", {
      name: `${title} case 2 Chat history`,
      exact: true,
    });
    await second
      .getByRole("button", { name: "Remove message 2", exact: true })
      .click();
    await second
      .getByRole("button", {
        name: "Remove history.png from message 1",
        exact: true,
      })
      .click();
    await second
      .getByLabel("Message 1", { exact: true })
      .fill("Different final question");
    await second
      .getByRole("button", { name: "Insert message before 1", exact: true })
      .click();
    for (const role of ["user", "assistant", "unfilled"])
      await second
        .getByRole("button", { name: `Message 1 role: ${role}`, exact: true })
        .click();
    await second
      .getByLabel("Message 1", { exact: true })
      .fill("A separate system instruction");
    await second
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await expect(
      second.getByRole("button", {
        name: "Message 3 role: unfilled",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "new variable", exact: true })
      .click();
    const token = side === "Rows" ? "$ROW1" : "$COLUMN1";
    await table
      .getByRole("button", { name: `Remove ${token}`, exact: true })
      .click();
    await expect(
      table.getByLabel(`${token}, case 1`, { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "new variable", exact: true })
      .click();
    const next = side === "Rows" ? "$ROW2" : "$COLUMN2";
    await expect(
      table.getByLabel(`${next}, case 1`, { exact: true }),
    ).toHaveValue("");
    await table
      .getByRole("button", { name: `Remove ${next}`, exact: true })
      .click();
    await page.reload();
    await expect(
      first.getByRole("img", { name: "history.png", exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("img", { name: "history.png", exact: true }),
    ).toHaveCount(0);
    await expect(second.getByLabel("Message 1", { exact: true })).toHaveValue(
      "A separate system instruction",
    );
    const before = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("slopgrid-draft")!).input,
    );
    expect(
      before[side.toLowerCase()].map(
        (record: { variable: unknown }) => record.variable,
      ),
    ).toEqual([
      [null, null],
      [null, null],
    ]);
    const cancellation = page.waitForEvent("dialog");
    const pending = table
      .getByRole("button", { name: "Make chat history common", exact: true })
      .click();
    await (await cancellation).dismiss();
    await pending;
    expect(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("slopgrid-draft")!).input,
      ),
    ).toEqual(before);
    await connectOpenRouter(page);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 2, 2);
    const requests = await (
      await page.request.get("/fixture/chat-requests")
    ).json();
    expect(requests).toHaveLength(2);
    const histories = requests.map(
      (request: {
        messages: {
          role: string;
          content: string | { type: string; text?: string }[];
        }[];
      }) =>
        request.messages.map((message) => ({
          role: message.role,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(""),
        })),
    );
    expect(histories).toContainEqual([
      { role: "user", content: "First complete question" },
    ]);
    expect(histories).toContainEqual([
      { role: "system", content: "A separate system instruction" },
      { role: "user", content: "Different final question" },
    ]);
  });
}

test("the direct parameter control explains disabled admission and targets the selected case dimension without losing input", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("Keep this complete prompt");
  const trigger = page.getByRole("button", {
    name: "define multiple cases for prompt",
    exact: true,
  });
  await expect(trigger).toBeDisabled();
  const action = trigger.locator("..");
  await action.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(/multiple cases/i);
  await expect(action).toHaveAccessibleDescription(/multiple cases/i);
  await expect(prompt).toHaveValue("Keep this complete prompt");
  await page
    .getByRole("heading", { name: "Enter your prompt", exact: true })
    .hover();
  await expect(tooltip).not.toBeVisible();
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const columns = page.getByRole("combobox", {
    name: "Columns",
    exact: true,
  });
  await columns.selectOption("variable");
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(columns).toHaveValue("variable");
  await expect(rows).toHaveValue("model");
  await expect(trigger).toHaveCount(0);
  const editor = page
    .getByRole("group", { name: "Column case 1 Prompt", exact: true })
    .getByLabel("Prompt", { exact: true });
  await expect(editor).toHaveValue("Keep this complete prompt");
  await expect(editor).toBeFocused();
});

test("case workspaces stay centered at normal width and grow only until the viewport cap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  const workspace = page.locator(".variable-editor");
  const bounds = async () => {
    const box = await workspace.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  };
  const empty = await bounds();
  expect(empty.x + empty.width / 2).toBeCloseTo(720, 0);
  const addField = page.getByRole("button", {
    name: "new variable",
    exact: true,
  });
  await addField.click();
  expect((await bounds()).width).toBeCloseTo(empty.width, 0);
  await addField.click();
  expect((await bounds()).width).toBeCloseTo(empty.width, 0);
  await addField.click();
  const growing = await bounds();
  expect(growing.width).toBeGreaterThan(empty.width);
  expect(growing.width).toBeLessThan(1440);
  expect(growing.x + growing.width / 2).toBeCloseTo(720, 0);
  await addField.click();
  await addField.click();
  const capped = await bounds();
  expect(capped.width).toBeLessThanOrEqual(1440);
  expect(capped.x).toBeGreaterThanOrEqual(0);
  expect(capped.x + capped.width / 2).toBeCloseTo(720, 0);
  const scroll = workspace.locator(".variable-table-scroll");
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await bounds();
  expect(phone.x).toBeGreaterThan(0);
  expect(phone.x + phone.width).toBeLessThan(390);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth),
    )
    .toBeLessThanOrEqual(390);
});
