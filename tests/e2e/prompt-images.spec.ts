import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  mockModels,
  selectModel,
  setVariableValues,
} from "./helpers";
import {
  picture,
  imageURL as dataURL,
  userContents as userContent,
} from "./image-input-helpers";

async function expectPromptPreview(editor: Locator, name: string) {
  const image = editor.getByRole("img", { name, exact: true });
  await expect(image).toBeVisible();
  await expect(
    editor.getByRole("button", {
      name: `Remove ${name} from prompt`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(editor.getByText(name, { exact: true })).toBeHidden();
  await expect
    .poll(async () => {
      const [preview, text] = await Promise.all([
        image.boundingBox(),
        editor.getByRole("textbox").boundingBox(),
      ]);
      return (
        preview !== null &&
        text !== null &&
        preview.y + preview.height <= text.y
      );
    })
    .toBe(true);
}

for (const format of ["Markdown", "SVG", "Static website"] as const) {
  test(`${format} prompt images merge with variable inputs and survive reload, Edit and Fork`, async ({
    page,
    request,
  }) => {
    const [common, variable] = await Promise.all([
      picture("prompt-red.png", "red"),
      picture("variable-blue.png", "blue"),
    ]);
    await request.post("/fixture/reset", {
      data: { markdownOutput: "# Prompt image output" },
    });
    await page.goto("/create");
    await connectOpenRouter(page);
    if (format === "Markdown") {
      await mockModels(page, (models) =>
        models.map((model) =>
          model.id === "fixture/other"
            ? { ...model, imageInput: false }
            : model,
        ),
      );
      await page.reload();
    }
    const formatButton = page.getByRole("button", {
      name: format,
      exact: true,
    });
    if ((await formatButton.getAttribute("aria-pressed")) !== "true")
      await formatButton.click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await setVariableValues(page, "Rows", ["shape"]);
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("effort");
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Recreate $ROW1 under context");
    await selectModel(
      page,
      format === "Markdown" ? "fixture/other" : "fixture/text",
    );
    await page
      .getByLabel("Add images to prompt", { exact: true })
      .setInputFiles(common);
    await expectPromptPreview(page.locator(".prompt-editor"), common.name);
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    if (format === "Markdown") {
      await expect(generate).toBeDisabled();
      await selectModel(page, "fixture/text");
    }
    await expect(
      page.getByLabel("Add images to $ROW1, case 1", { exact: true }),
    ).toBeEnabled();
    await page
      .getByLabel("Add images to $ROW1, case 1", { exact: true })
      .setInputFiles(variable);
    await expect(
      page.getByRole("img", { name: variable.name, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("img", { name: common.name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: variable.name, exact: true }),
    ).toBeVisible();
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/grids",
    );
    await generate.click();
    const creation = await created;
    expect(creation.status()).toBe(201);
    const { id } = await creation.json();
    await expect(page).toHaveURL(new RegExp(`/grid/${id}$`));
    await expectProgress(page, 1, 1);
    const sent = await (await request.get("/fixture/chat-requests")).json();
    expect(sent).toHaveLength(1);
    expect(sent[0].modalities).toEqual(["text"]);
    expect(userContent(sent[0].messages)).toEqual([
      {
        text: "Recreate shape under context",
        images: [dataURL(common), dataURL(variable)],
      },
    ]);
    if (format === "Static website") {
      await expect(
        page
          .frameLocator("iframe:visible")
          .first()
          .getByRole("heading", { name: "A generated site", exact: true }),
      ).toBeVisible();
    } else {
      const url = await page
        .getByRole("link", { name: "Open output", exact: true })
        .getAttribute("href");
      const rawURL = new URL(url!, page.url());
      rawURL.searchParams.set("raw", "1");
      const output = await page.request.get(rawURL.href);
      expect(await output.text()).toContain(
        format === "SVG" ? "<svg" : "# Prompt image output",
      );
    }
    const gridURL = page.url();
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await page.reload();
    await expect(
      page.getByRole("img", { name: common.name, exact: true }),
    ).toBeVisible();
    if (format === "Markdown") {
      for (const other of [
        "SVG",
        "Static website",
        "Image",
        "Markdown",
      ] as const) {
        await page.getByRole("button", { name: other, exact: true }).click();
        await expect(
          page.getByRole("img", { name: common.name, exact: true }),
        ).toBeVisible();
      }
      await page
        .getByRole("button", { name: "Chat completion", exact: true })
        .click();
      await expect(
        page.getByRole("img", { name: common.name, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Markdown", exact: true }).click();
      await expect(
        page.getByRole("img", { name: common.name, exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", {
        name: `Remove ${common.name} from prompt`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("img", { name: common.name, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("img", { name: variable.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Recreate $ROW1 under context",
    );
    await page.goto(gridURL);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await finishPublishing(page);
    await page.getByRole("button", { name: "FORK", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await page.reload();
    await expect(
      page.getByRole("img", { name: common.name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: variable.name, exact: true }),
    ).toBeVisible();
  });
}

test.describe("phone prompt attachments", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("a pasted image can be the entire Markdown prompt", async ({
    page,
    request,
    context,
  }) => {
    await request.post("/fixture/reset", {
      data: { markdownOutput: "# Image-only input" },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/create");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await connectOpenRouter(page);
    await page.getByRole("button", { name: "Swap rows and columns" }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("model");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("effort");
    const models = page.getByRole("group", { name: "Row values", exact: true });
    await models.getByRole("searchbox").fill("fixture/text");
    await models
      .locator('input[type="checkbox"][value="fixture/text"]')
      .check();
    const picked = await picture("picker-blue.png", "blue");
    await page
      .getByLabel("Add images to prompt", { exact: true })
      .setInputFiles(picked);
    const editor = page.locator(".prompt-editor");
    await expectPromptPreview(editor, picked.name);
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 16;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 32, 16);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
    });
    const prompt = page.getByLabel("Prompt", { exact: true });
    await prompt.focus();
    await prompt.press("ControlOrMeta+V");
    await expect(editor.getByRole("img")).toHaveCount(2);
    const pastedName = await editor.getByRole("img").nth(1).getAttribute("alt");
    expect(pastedName).toBeTruthy();
    expect(pastedName).not.toBe(picked.name);
    await expectPromptPreview(editor, pastedName!);
    await editor
      .getByRole("button", {
        name: `Remove ${picked.name} from prompt`,
        exact: true,
      })
      .click();
    await expect(
      editor.getByRole("img", { name: picked.name, exact: true }),
    ).toHaveCount(0);
    await expectPromptPreview(editor, pastedName!);
    await expect(editor.getByRole("img")).toHaveCount(1);
    await expect(prompt).toHaveValue("");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 1, 1);
    const sent = await (await request.get("/fixture/chat-requests")).json();
    expect(sent).toHaveLength(1);
    const turns = userContent(sent[0].messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("");
    expect(turns[0].images).toHaveLength(1);
    const decoded = await page.evaluate(async (source) => {
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
        pixel: [...context.getImageData(16, 8, 1, 1).data],
      };
    }, turns[0].images[0]);
    expect(decoded).toEqual({ width: 32, height: 16, pixel: [255, 0, 0, 255] });
  });
});
