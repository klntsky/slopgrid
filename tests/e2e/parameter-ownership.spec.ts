import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  setVariableValues,
  moveParameter,
  selectModel,
} from "./helpers";
import { referencePng } from "../reference-image-fixture";

test("column parameter actions remain usable without a row-owned parameter and preserve equal values", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const table = page.getByRole("table", {
    name: "Grid layout parameters",
    exact: true,
  });
  const models = page.getByRole("group", { name: "Row values", exact: true });
  await models.getByRole("searchbox").fill("fixture/text");
  await models.locator('input[type="checkbox"][value="fixture/text"]').check();
  await page
    .getByRole("button", { name: "Make model common", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Columns", ["Alpha", "Beta"]);
  await page.getByLabel("Prompt", { exact: true }).fill("Draw $COLUMN1");
  await moveParameter(page, "model", "columns");
  await expect(
    table
      .getByRole("group", { name: "Column case 1 Model", exact: true })
      .getByRole("searchbox"),
  ).toBeFocused();
  await table
    .getByRole("button", { name: "Make model common", exact: true })
    .click();
  const common = page.getByRole("radiogroup", { name: "Model", exact: true });
  await common.getByRole("searchbox").fill("fixture/text");
  await expect(
    common.locator('input[type="radio"][value="fixture/text"]'),
  ).toBeChecked();
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
  expect(
    grid.cells.map((cell: { model: string; prompt: string }) => [
      cell.model,
      cell.prompt,
    ]),
  ).toEqual([
    ["fixture/text", "Draw Alpha"],
    ["fixture/text", "Draw Beta"],
  ]);
});

test("case image attachments keep their identity across formats without restoring removed cases", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  const files = [
    { name: "Alpha.png", mimeType: "image/png", buffer: referencePng },
    {
      name: "Beta.png",
      mimeType: "image/png",
      buffer: Buffer.concat([referencePng, Buffer.from("second")]),
    },
  ];
  await setVariableValues(page, "Rows", ["Alpha", "Beta"]);
  await page.getByLabel("Prompt", { exact: true }).fill("Describe $ROW1");
  await page
    .getByLabel("Add images to $ROW1, case 1", { exact: true })
    .setInputFiles(files[0]);
  await page
    .getByLabel("Add images to $ROW1, case 2", { exact: true })
    .setInputFiles(files[1]);
  await expect(
    page.getByRole("img", { name: "Beta.png", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("button", { name: "Move row case 2", exact: true })
    .press("ArrowUp");
  await page
    .getByRole("button", { name: "Remove row case 2", exact: true })
    .click();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove row case 2", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("$ROW1, case 1", { exact: true })).toHaveValue(
    "Beta",
  );
  await expect(
    page.getByRole("img", { name: "Alpha.png", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Beta.png", exact: true }),
  ).toBeVisible();
  await selectModel(page, "fixture/image");
  await connectOpenRouter(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const calls = await (await request.get("/fixture/image-requests")).json();
  expect(
    calls.map((call: { prompt: string; input_references: unknown[] }) => ({
      prompt: call.prompt,
      images: call.input_references,
    })),
  ).toEqual([
    {
      prompt: "Describe Beta",
      images: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${files[1].buffer.toString("base64")}`,
          },
        },
      ],
    },
  ]);
});
