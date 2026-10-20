import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  mockModels,
  selectModel,
} from "./helpers";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const image = { name: "chat.png", mimeType: "image/png", buffer: png };

async function appendMessage(page: Page) {
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
}

async function unsupportedOtherModel(page: Page) {
  await page.goto("/create");
  await connectOpenRouter(page);
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/other" ? { ...model, imageInput: false } : model,
    ),
  );
}

test("chat image uploads block unsupported fixed and axis models and persist across completion calls", async ({
  page,
  request,
}) => {
  await unsupportedOtherModel(page);
  const answer = "An image answer.";
  await request.post("/fixture/reset", { data: { markdownOutput: answer } });
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
  await selectModel(page, "fixture/other");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeEnabled();
  await page
    .getByLabel("Add input references", { exact: true })
    .setInputFiles(image);
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Remove chat.png from Input references",
      exact: true,
    })
    .click();
  await expect(generate).toBeEnabled();
  await page
    .getByLabel("Add input references", { exact: true })
    .setInputFiles(image);
  await expect(generate).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  await selectModel(page, "fixture/text");
  await expect(generate).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Describe this image. $ROW");
  const models = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await models.getByRole("searchbox").fill("");
  await expect(generate).toBeEnabled();
  await models
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  await expect(generate).toBeDisabled();
  await models
    .getByRole("checkbox", { name: "Second model", exact: true })
    .uncheck();
  await expect(generate).toBeEnabled();
  await appendMessage(page);
  await page
    .getByRole("button", { name: "Message 2 role: assistant", exact: true })
    .click();
  await appendMessage(page);
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Describe another detail.");
  await appendMessage(page);
  await page
    .getByRole("button", { name: "Message 4 role: assistant", exact: true })
    .click();
  const uploading = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/references",
  );
  await generate.click();
  const reference = await (await uploading).json();
  expect(
    await (await page.request.get(`/api/references/${reference.id}`)).body(),
  ).toEqual(png);
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/chat-requests")).json();
  expect(sent).toHaveLength(2);
  const firstUser = sent[0].messages.find(
    (message: { role: string }) => message.role === "user",
  );
  expect(firstUser.content).toEqual(
    expect.arrayContaining([
      { type: "text", text: "Describe this image. one" },
      expect.objectContaining({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
      }),
    ]),
  );
  expect(sent[1].messages).toEqual(
    expect.arrayContaining([
      firstUser,
      { role: "assistant", content: answer },
      {
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "Describe another detail.",
          }),
        ]),
      },
    ]),
  );
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeEnabled();
});

test("chat input-reference dimensions survive image format transitions and grid editing", async ({
  page,
  request,
}) => {
  await unsupportedOtherModel(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Describe the reference.");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("input_references");
  await page
    .getByLabel("Add reference group", { exact: true })
    .setInputFiles(image);
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("input_references");
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("input_references");
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Add input references", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Quality", exact: true }),
  ).toHaveCount(0);
  const models = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await models.getByRole("searchbox").fill("");
  await models
    .getByRole("checkbox", { name: "Fixture text", exact: true })
    .check();
  await models
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await models
    .getByRole("checkbox", { name: "Second model", exact: true })
    .uncheck();
  await expect(generate).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
  await generate.click();
  await expectProgress(page, 1, 1);
  const grid = await (
    await page.request.get(
      `/api/grids/${new URL(page.url()).pathname.split("/").pop()}`,
    )
  ).json();
  expect(grid.input.rows).toEqual({
    kind: "input_references",
    values: ["Group 1"],
  });
  expect(grid.input.referenceGroups["Group 1"]).toEqual([
    { id: expect.not.stringMatching(/^local-/), name: image.name },
  ]);
  const sent = await (await request.get("/fixture/chat-requests")).json();
  expect(
    sent[0].messages.find(
      (message: { role: string }) => message.role === "user",
    ).content,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
      }),
    ]),
  );
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("input_references");
  await expect(
    page.getByRole("img", { name: image.name, exact: true }),
  ).toBeVisible();
});
