import { test, expect } from "./fixtures";
import { mockModels } from "./helpers";
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
    await expect(table.getByRole("textbox")).toHaveCount(1);
    await expect(
      table.getByLabel("$ROW1, case 1", { exact: true }),
    ).toHaveValue("");
    await expect(
      table.getByRole("button", { name: "Remove row case 1", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".axes table")).toHaveCount(0);
    const axesBox = await page.locator(".axes").boundingBox();
    const tableBox = await table.boundingBox();
    expect(tableBox!.y).toBeGreaterThanOrEqual(axesBox!.y + axesBox!.height);

    await page
      .getByRole("button", {
        name: "Make Model a column variable",
        exact: true,
      })
      .click();
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
    await expect(table.getByRole("columnheader")).toHaveCount(1);
    await expect(table.getByRole("rowheader")).toHaveCount(1);
    await expect(table.getByRole("textbox")).toHaveCount(1);

    await table
      .getByRole("button", { name: "Add row case", exact: true })
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
  await table
    .getByRole("button", { name: "Add row variable", exact: true })
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
  await table
    .getByRole("button", { name: "Add row variable", exact: true })
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
  await expect(table.getByRole("columnheader")).toHaveCount(1);
  await expect(table.getByRole("rowheader")).toHaveCount(2);
  await expect(
    table.getByLabel("$COLUMN2, case 1", { exact: true }),
  ).toHaveValue("keep this field");
  await expect(
    table.getByLabel("$COLUMN3, case 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    table.getByRole("rowheader").first().locator(".row-label"),
  ).toHaveText("$COLUMN2");
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
  const rowCriteria = judge.getByRole("button", {
    name: "Make Judge criteria a row variable",
    exact: true,
  });
  await expect(rowCriteria).toBeDisabled();
  await expect(
    judge.getByRole("radiogroup", { name: "Judge model", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("button", { name: "Make Model a row variable", exact: true })
    .click();
  await judge
    .getByRole("button", {
      name: "Make Judge model a row variable",
      exact: true,
    })
    .click();
  await judge
    .getByRole("button", {
      name: "Make Judge thinking effort a row variable",
      exact: true,
    })
    .click();
  await rowCriteria.click();
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  await expect(table).toHaveCount(1);
  await expect(
    table.getByLabel("$ROW1, case 1", { exact: true }),
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
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("variable");
  await expect(
    page.getByRole("group", { name: "Column values", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add row case", exact: true }).click();
  await expect(table).toBeVisible();
  await table
    .getByLabel("$ROW1, case 1", { exact: true })
    .fill("restored question");
  await page.reload();
  await expect(table.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "restored question",
  );
});
