import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  mockModels,
  selectModel,
  setVariableValues,
} from "./helpers";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const firstImage = { name: "first.png", mimeType: "image/png", buffer: png };
const laterImage = {
  name: "later.png",
  mimeType: "image/png",
  buffer: Buffer.concat([png, Buffer.from("later image")]),
};
type WireMessage = {
  role: string;
  content:
    string | { type: string; text?: string; image_url?: { url: string } }[];
};
function userTurns(request: { messages: WireMessage[] }) {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      text:
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
      images:
        typeof message.content === "string"
          ? []
          : message.content
              .filter((part) => part.type === "image_url")
              .map((part) => part.image_url!.url),
    }));
}
const dataURL = (image: typeof firstImage) =>
  `data:image/png;base64,${image.buffer.toString("base64")}`;

async function appendMessage(page: Page) {
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
}
async function appendCompletionAndUser(page: Page) {
  await appendMessage(page);
  await appendMessage(page);
}
async function appendFinalCompletion(page: Page) {
  await appendMessage(page);
}
async function variableAxes(page: Page) {
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["one"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Columns", ["one"]);
}
async function unsupportedOtherModel(page: Page) {
  await page.goto("/create");
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
}

test("message attachments gate every model and reach only their own completion turns", async ({
  page,
  request,
}) => {
  await unsupportedOtherModel(page);
  const answer = "An image answer.";
  await request.post("/fixture/reset", { data: { markdownOutput: answer } });
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Describe the first image. $ROW1 $COLUMN1");
  await appendCompletionAndUser(page);
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Describe the later image.");
  await appendFinalCompletion(page);
  await variableAxes(page);
  await selectModel(page, "fixture/other");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeEnabled();
  await page
    .getByLabel("Add images to message 3", { exact: true })
    .setInputFiles(laterImage);
  await expect(
    page.getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  await page
    .getByRole("button", {
      name: `Remove ${laterImage.name} from message 3`,
      exact: true,
    })
    .click();
  await expect(generate).toBeEnabled();
  await page
    .getByLabel("Add images to message 3", { exact: true })
    .setInputFiles(laterImage);
  await expect(generate).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  await selectModel(page, "fixture/text");
  await expect(generate).toBeEnabled();
  await page
    .getByRole("button", {
      name: `Remove ${laterImage.name} from message 3`,
      exact: true,
    })
    .click();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Describe the first image. $ROW1");
  const models = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  await models.getByRole("searchbox").fill("");
  await models
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  await page
    .getByLabel("Add images to message 3", { exact: true })
    .setInputFiles(laterImage);
  await expect(generate).toBeDisabled();
  await models
    .getByRole("button", {
      name: "Remove fixture/other from columns",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Add images to message 1", { exact: true })
    .setInputFiles(firstImage);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/chat-requests")).json();
  expect(sent).toHaveLength(2);
  const initialTurn = {
    text: "Describe the first image. one",
    images: [dataURL(firstImage)],
  };
  expect(userTurns(sent[0])).toEqual([initialTurn]);
  expect(userTurns(sent[1])).toEqual([
    initialTurn,
    { text: "Describe the later image.", images: [dataURL(laterImage)] },
  ]);
  expect(sent[1].messages).toContainEqual({
    role: "assistant",
    content: answer,
  });
  const grid = await (
    await page.request.get(
      `/api/grids/${new URL(page.url()).pathname.split("/").pop()}`,
    )
  ).json();
  expect(
    await (
      await page.request.get(
        `/api/references/${grid.input.messages[0].images[0].id}`,
      )
    ).body(),
  ).toEqual(firstImage.buffer);
  expect(
    await (
      await page.request.get(
        `/api/references/${grid.input.messages[2].images[0].id}`,
      )
    ).body(),
  ).toEqual(laterImage.buffer);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page).toHaveURL("/create");
  await page.reload();
  await expect(
    page
      .locator(".chat-message")
      .nth(0)
      .getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message")
      .nth(2)
      .getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(generate).toBeEnabled();
});

test("image-only message attachments follow reorder, format switches, Edit and Fork", async ({
  page,
  request,
}) => {
  await unsupportedOtherModel(page);
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Image understood." },
  });
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("First question $ROW1 $COLUMN1");
  await page
    .getByLabel("Add images to message 1", { exact: true })
    .setInputFiles(firstImage);
  await expect(
    page.getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
  await appendCompletionAndUser(page);
  await page
    .getByLabel("Add images to message 3", { exact: true })
    .setInputFiles(laterImage);
  await expect(
    page.getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Message 3 role: user", exact: true }),
  ).toBeDisabled();
  await appendFinalCompletion(page);
  await page
    .getByRole("button", { name: "Move message 3", exact: true })
    .press("ArrowUp");
  await page
    .getByRole("button", { name: "Move message 2", exact: true })
    .press("ArrowUp");
  await page.reload();
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue("");
  await expect(
    page
      .locator(".chat-message")
      .nth(0)
      .getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message")
      .nth(1)
      .getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Rows", exact: true })
      .locator('option[value="input_references"]'),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Rows", exact: true })
      .locator('option[value="input_references"]'),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".chat-message")
      .nth(0)
      .getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message")
      .nth(1)
      .getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
  await variableAxes(page);
  await selectModel(page, "fixture/text");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/chat-requests")).json();
  expect(userTurns(sent[0])).toEqual([
    { text: "", images: [dataURL(laterImage)] },
    { text: "First question one one", images: [dataURL(firstImage)] },
  ]);
  const gridURL = page.url();
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(
    page
      .locator(".chat-message")
      .nth(0)
      .getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message")
      .nth(1)
      .getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
  await page.goto(gridURL);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Message 1", { exact: true })).toHaveValue("");
  await expect(
    page
      .locator(".chat-message")
      .nth(0)
      .getByRole("img", { name: laterImage.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message")
      .nth(1)
      .getByRole("img", { name: firstImage.name, exact: true }),
  ).toBeVisible();
});

test("clipboard images attach to their user turn and disabled role badges retain tooltips", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await unsupportedOtherModel(page);
  await variableAxes(page);
  await selectModel(page, "fixture/other");
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Clipboard answer." },
  });
  const first = page.getByLabel("Message 1", { exact: true });
  await first.fill("Earlier $ROW1 $COLUMN1");
  await page.evaluate(() => navigator.clipboard.writeText("\nNotes"));
  await first.press("End");
  await first.press("ControlOrMeta+V");
  await expect(first).toHaveValue("Earlier $ROW1 $COLUMN1\nNotes");
  await appendCompletionAndUser(page);
  const clipboardBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const paint = canvas.getContext("2d")!;
    paint.fillStyle = "red";
    paint.fillRect(0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": image }),
    ]);
    const items = await navigator.clipboard.read();
    return Array.from(
      new Uint8Array(await (await items[0].getType("image/png")).arrayBuffer()),
    );
  });
  await page.getByLabel("Message 3", { exact: true }).press("ControlOrMeta+V");
  const later = page.locator(".chat-message").nth(2);
  await expect(later.locator(".reference-image img")).toBeVisible();
  await expect(
    later.getByRole("button", { name: "Message 3 role: user", exact: true }),
  ).toBeDisabled();
  await later.locator(".chat-role-hint").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await first.hover();
  await expect(page.getByRole("tooltip")).toBeHidden();
  await later.locator(".chat-role-hint").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await appendFinalCompletion(page);
  await page.reload();
  await expect(later.locator(".reference-image img")).toBeVisible();
  await expect(page.getByLabel("Message 3", { exact: true })).toHaveValue("");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await selectModel(page, "fixture/text");
  await generate.click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/chat-requests")).json();
  const initial = { text: "Earlier one one\nNotes", images: [] };
  expect(userTurns(sent[0])).toEqual([initial]);
  expect(userTurns(sent[1])).toEqual([
    initial,
    {
      text: "",
      images: [
        `data:image/png;base64,${Buffer.from(clipboardBytes).toString("base64")}`,
      ],
    },
  ]);
});
