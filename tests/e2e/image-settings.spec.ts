import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  connectOpenRouter,
  finishPublishing,
  expectProgress,
  selectModel,
  mockModels,
} from "./helpers";

async function setup(page: Page, connect = true) {
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("model");
  if (connect) {
    await connectOpenRouter(page);
  }
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
}

test("image warning grids compare models with parameter values and remain advisory, while custom sizes and settings reach inference", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await setup(page);
  const rows = page.getByRole("combobox", { name: "Rows", exact: true });
  const columns = page.getByRole("combobox", { name: "Columns", exact: true });
  await rows.selectOption("quality");
  await page.getByRole("checkbox", { name: "low", exact: true }).check();
  await page.getByRole("checkbox", { name: "high", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  const table = page.getByRole("table", {
    name: "Quality compatibility",
  });
  await expect(
    table.getByRole("cell", {
      name: "Fixture image / low: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    table.getByRole("cell", {
      name: "Fixture image / high: Supported",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(table.getByRole("rowheader")).toHaveText(["Fixture image"]);
  await expect(
    table.getByRole("cell", {
      name: "Fixture image / low: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await rows.selectOption("background");
  await selectModel(page, "fixture/image");
  await page
    .getByRole("checkbox", { name: "transparent", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "opaque", exact: true }).check();
  await page.getByRole("checkbox", { name: "low", exact: true }).uncheck();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  const parameters = page.getByRole("dialog", {
    name: "Parameters",
    exact: true,
  });
  await page.getByRole("button", { name: "Parameters", exact: true }).click();
  await expect(parameters).toBeVisible();
  await parameters.getByRole("button", { name: "Close parameters" }).click();
  await expect(parameters).not.toBeVisible();
  let sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent.map((r: any) => [r.quality, r.background]).sort()).toEqual([
    ["high", "opaque"],
    ["high", "transparent"],
  ]);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await rows.selectOption("size");
  await columns.selectOption("aspect_ratio");
  await page.getByRole("checkbox", { name: "2K", exact: true }).check();
  await page.getByRole("checkbox", { name: "Custom", exact: true }).check();
  await page
    .getByLabel("Custom rows size 1 width", { exact: true })
    .fill("1536");
  await page
    .getByLabel("Custom rows size 1 height", { exact: true })
    .fill("1024");
  await page
    .getByRole("button", { name: "Add custom rows size", exact: true })
    .click();
  await page
    .getByLabel("Custom rows size 2 width", { exact: true })
    .fill("768");
  await page
    .getByLabel("Custom rows size 2 height", { exact: true })
    .fill("512");
  await page.getByRole("checkbox", { name: "3:2", exact: true }).check();
  await page
    .getByRole("button", { name: "Add custom rows size", exact: true })
    .click();
  await page
    .getByLabel("Custom rows size 3 width", { exact: true })
    .fill("256");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await page.reload();
  await expect(
    page.getByLabel("Custom rows size 3 width", { exact: true }),
  ).toHaveValue("256");
  await expect(
    page.getByLabel("Custom rows size 3 height", { exact: true }),
  ).toHaveValue("");
  await expect(generate).toBeDisabled();
  expect(
    await (await request.get("/fixture/image-requests")).json(),
  ).toHaveLength(2);
  await page
    .getByRole("button", { name: "Remove custom rows size 3", exact: true })
    .click();
  await expect(
    page
      .getByRole("table", { name: "Size compatibility", exact: true })
      .getByRole("cell", {
        name: "Fixture image / 768x512: Unsupported",
        exact: true,
      }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(
    page.getByLabel("Custom columns size 2 width", { exact: true }),
  ).toHaveValue("768");
  await page.reload();
  await expect(
    page.getByLabel("Custom columns size 1 height", { exact: true }),
  ).toHaveValue("1024");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 3, 3);
  sent = await (await request.get("/fixture/image-requests")).json();
  expect(
    sent
      .slice(2)
      .map((r: any) => [
        r.size,
        r.aspect_ratio,
        r.quality,
        r.background,
        r.prompt,
      ])
      .sort(),
  ).toEqual([
    ["1536x1024", "3:2", undefined, undefined, "Draw a landscape"],
    ["2K", "3:2", undefined, undefined, "Draw a landscape"],
    ["768x512", "3:2", undefined, undefined, "Draw a landscape"],
  ]);
});

test("renamed reference groups survive reload, Edit and Fork without mixing their files", async ({
  page,
  request,
  browser,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await setup(page, false);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("input_references");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("size");
  await selectModel(page, "fixture/image");
  await page.getByRole("checkbox", { name: "1K", exact: true }).check();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const file = (name: string) => ({
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([png, Buffer.from(name)]),
  });
  const first = [file("one.png"), file("two.png")],
    second = [file("three.png"), file("four.png"), file("five.png")];
  await page
    .getByLabel("Add reference group", { exact: true })
    .setInputFiles(first);
  await expect(page.getByRole("img", { name: "two.png" })).toBeVisible();
  await page
    .getByLabel("Add reference group", { exact: true })
    .setInputFiles(second.slice(0, 1));
  await expect(page.getByRole("img", { name: "three.png" })).toBeVisible();
  await page
    .getByLabel("Add images to Group 2", { exact: true })
    .setInputFiles(second.slice(1));
  const titles = page.getByRole("button", {
    name: /^Edit reference group title:/,
  });
  const titleField = page.getByRole("textbox", {
    name: "Reference group title",
  });
  // Removing all files preserves the group and its title until it is refilled.
  for (const image of first)
    await page
      .getByRole("button", {
        name: `Remove ${image.name} from Group 1`,
        exact: true,
      })
      .click();
  await expect(titles.nth(0)).toHaveText("Group 1");
  await page.reload();
  await expect(titles.nth(0)).toHaveText("Group 1");
  await connectOpenRouter(page);
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await generate.locator("..").focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "Add images to every reference group",
  );
  await page
    .getByLabel("Add images to Group 1", { exact: true })
    .setInputFiles(first);
  await expect(page.getByRole("img", { name: "two.png" })).toBeVisible();
  await titles.nth(0).click();
  await titleField.fill("Landscape");
  await titleField.press("Enter");
  await titles.nth(1).click();
  await titleField.fill("Details");
  await titleField.press("Tab");
  const warning = page.getByRole("cell", {
    name: "Fixture image / Details: Unsupported",
    exact: true,
  });
  await expect(warning).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "five.png" })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await expect(titles.nth(0)).toHaveText("Landscape");
  await expect(titles.nth(1)).toHaveText("Details");
  // Rejected titles preserve both groups and their file associations.
  for (const invalid of ["Landscape", "   "]) {
    await titles.nth(1).click();
    await titleField.fill(invalid);
    await titleField.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      invalid.trim()
        ? "Use a different reference group title."
        : "Enter a reference group title.",
    );
    await titleField.press("Escape");
    await expect(titles.nth(1)).toHaveText("Details");
  }
  await titles.nth(1).click();
  await titleField.fill("Discard this edit");
  await titleField.press("Escape");
  await expect(titles.nth(1)).toBeFocused();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(
    page.getByRole("cell", {
      name: "Fixture image / Details: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await request.post("/fixture/reset", {
    data: { referenceStorageFailure: true },
  });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not upload one.png.");
  expect(await (await request.get("/fixture/image-requests")).json()).toEqual(
    [],
  );
  await request.post("/fixture/reset", { data: {} });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  const sent = await (await request.get("/fixture/image-requests")).json();
  const expected = [first, second].map((group) =>
    group.map((f) => ({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${f.buffer.toString("base64")}`,
      },
    })),
  );
  expect(
    sent
      .map((r: any) => r.input_references)
      .sort((a: any[], b: any[]) => a.length - b.length),
  ).toEqual(expected);
  const url = page.url();
  async function expandReference(
    target: import("@playwright/test").Page,
    orientation: "columnheader" | "rowheader",
    name: string,
    escape = true,
  ) {
    const thumbnail = target.getByRole(orientation).getByRole("button", {
      name: `Expand reference image: ${name}`,
      exact: true,
    });
    const source = await thumbnail.getByRole("img").getAttribute("src");
    await thumbnail.click();
    const expanded = target.getByRole("region", {
      name: `Expanded reference: ${name}`,
      exact: true,
    });
    const image = expanded.getByRole("img", { name, exact: true });
    await expect(image).toHaveAttribute("src", source!);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    if (escape) await target.keyboard.press("Escape");
    else
      await expanded
        .getByRole("button", { name: "Collapse Image", exact: true })
        .click();
    await expect(expanded).toHaveCount(0);
    await expect(thumbnail).toBeFocused();
    return source!;
  }
  // Reloaded headers use saved files rather than local selection or generated output.
  await page.reload();
  const source = await expandReference(page, "columnheader", "two.png");
  expect(await (await page.request.get(source)).body()).toEqual(
    first[1].buffer,
  );
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(titles.nth(0)).toHaveText("Landscape");
  await expect(titles.nth(1)).toHaveText("Details");
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "five.png" })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.goto(url);
  const visitor = await browser.newContext();
  try {
    expect(
      (await visitor.request.get(new URL(source, url).href)).status(),
    ).toBe(404);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await finishPublishing(page);
    const publicPage = await visitor.newPage();
    await publicPage.goto(url);
    await expandReference(publicPage, "columnheader", "five.png", false);
    const parameters = publicPage.getByRole("dialog", {
      name: "Parameters",
      exact: true,
    });
    await publicPage
      .getByRole("button", { name: "Parameters", exact: true })
      .click();
    await expect(parameters.getByRole("img")).toHaveCount(0);
  } finally {
    await visitor.close();
  }
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expect(titles.nth(0)).toHaveText("Landscape");
  await expect(titles.nth(1)).toHaveText("Details");
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  await page.reload();
  await expandReference(page, "rowheader", "one.png");
  expect(
    (await (await request.get("/fixture/image-requests")).json())
      .map((r: any) => r.input_references)
      .sort((a: any[], b: any[]) => a.length - b.length),
  ).toEqual(expected);
});

test("image model prices preserve published units and tiers without changing selection or compatibility", async ({
  page,
}) => {
  await setup(page, false);
  const list = page.getByRole("group", { name: "Column values" });
  const item = (name: string) =>
    list
      .locator("label.checkbox")
      .filter({ has: page.getByRole("checkbox", { name, exact: true }) });
  await expect(
    item("Fixture image").getByText("$0.04/image", { exact: true }),
  ).toBeVisible();
  await expect(
    item("Fixture megapixels").getByText("$0.003/MP", { exact: true }),
  ).toBeVisible();
  const tokens = item("Fixture tokens").getByText("$40.00–$80.00/1M tokens", {
    exact: true,
  });
  await expect(tokens).toBeVisible();
  await expect(
    item("Fixture unpriced").getByText("Price unavailable", { exact: true }),
  ).toBeVisible();
  await tokens.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Input text: $5.00/1M tokens");
  await expect(tip).toContainText("Output image (high): $80.00/1M tokens");
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("quality");
  await page.getByRole("checkbox", { name: "low", exact: true }).check();
  await expect(
    page.getByRole("cell", {
      name: "Fixture image / low: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(
    page
      .getByRole("group", { name: "Row values" })
      .getByRole("checkbox", { name: "Fixture image", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("group", { name: "Row values" })
      .getByText("$0.04/image", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "Row values" })
      .getByText("$0.04/image", { exact: true }),
  ).toBeVisible();
});

test("shared image settings transfer to axes, reset on removal, and preserve defaults through Edit and Fork", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await setup(page);
  const field = (name: string) =>
    page.getByRole("combobox", { name, exact: true });
  await field("Rows").selectOption("quality");
  await page.getByRole("checkbox", { name: "Auto", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await field("Background").selectOption("transparent");
  await field("Rows").selectOption("background");
  await expect(
    page.getByRole("checkbox", { name: "transparent", exact: true }),
  ).toBeChecked();
  await expect(field("Background")).toHaveCount(0);
  await expect(field("Quality")).toHaveValue("auto");
  await field("Rows").selectOption("quality");
  await expect(field("Background")).toHaveValue("auto");
  await page.getByRole("checkbox", { name: "Auto", exact: true }).check();
  await field("Aspect ratio").selectOption("3:2");
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveCount(0);
  await field("Size").selectOption("custom");
  await page.getByLabel("Custom size width", { exact: true }).fill("1536");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();
  await generate.locator("..").focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "Use a resolution or a size such as 1536x1024",
  );
  await page.reload();
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveValue("1536");
  await expect(
    page.getByLabel("Custom size height", { exact: true }),
  ).toHaveValue("");
  await expect(generate).toBeDisabled();
  expect(
    await (await request.get("/fixture/image-requests")).json(),
  ).toHaveLength(0);
  await page.getByLabel("Custom size height", { exact: true }).fill("1024");
  await expect(field("Size")).toHaveValue("custom");
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveValue("1536");
  await expect(
    page.getByLabel("Custom size height", { exact: true }),
  ).toHaveValue("1024");
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await page.reload();
  await expect(field("Size")).toHaveValue("custom");
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveValue("1536");
  await expect(
    page.getByLabel("Custom size height", { exact: true }),
  ).toHaveValue("1024");
  await expect(field("Aspect ratio")).toHaveValue("3:2");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  let sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent[0].size).toBe("1536x1024");
  expect(sent[0].aspect_ratio).toBe("3:2");
  const parameters = page.getByRole("dialog", {
    name: "Parameters",
    exact: true,
  });
  const parameterValues = parameters.getByRole("definition");
  await expect(parameterValues.first()).not.toBeVisible();
  const parameterButton = page.getByRole("button", {
    name: "Parameters",
    exact: true,
  });
  await parameterButton.focus();
  await parameterButton.press("Enter");
  await expect(parameterValues.nth(0)).toHaveText("1536x1024");
  await expect(parameterValues.nth(1)).toHaveText("3:2");
  await page.keyboard.press("Escape");
  await expect(parameterValues.first()).not.toBeVisible();
  await expect(parameterButton).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await parameterButton.click();
  await expect(parameters).toBeVisible();
  const panel = await parameters.boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  await parameterButton.click();
  await expect(parameters).not.toBeVisible();
  for (const key of ["quality", "background", "input_references"])
    expect(sent[0]).not.toHaveProperty(key);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(field("Size")).toHaveValue("custom");
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveValue("1536");
  await expect(
    page.getByLabel("Custom size height", { exact: true }),
  ).toHaveValue("1024");
  await field("Size").selectOption("auto");
  await field("Aspect ratio").selectOption("auto");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  sent = await (await request.get("/fixture/image-requests")).json();
  for (const key of [
    "size",
    "aspect_ratio",
    "quality",
    "background",
    "input_references",
  ])
    expect(sent[1]).not.toHaveProperty(key);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await field("Columns").selectOption("background");
  await page.getByRole("checkbox", { name: "Auto", exact: true }).check();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  expect(
    await (await request.get("/fixture/image-requests")).json(),
  ).toHaveLength(2);
});

test("shared references survive uploads, reload, publication and forks, and transfer to an axis", async ({
  page,
  request,
  browser,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await setup(page);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("quality");
  await page.getByRole("checkbox", { name: "high", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const files = ["shared-one.png", "shared-two.png"].map((name) => ({
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([png, Buffer.from(name)]),
  }));
  await page
    .getByLabel("Add input references", { exact: true })
    .setInputFiles(files);
  await expect(
    page.getByRole("img", { name: files[1].name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("img", { name: files[0].name, exact: true }),
  ).toBeVisible();
  await request.post("/fixture/reset", {
    data: { referenceStorageFailure: true },
  });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not upload shared-one.png.",
  );
  await request.post("/fixture/reset", { data: {} });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent[0].input_references).toEqual(
    files.map((file) => ({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${file.buffer.toString("base64")}`,
      },
    })),
  );
  const url = page.url();
  await page.reload();
  const parameters = page.getByRole("dialog", {
    name: "Parameters",
    exact: true,
  });
  await page.getByRole("button", { name: "Parameters", exact: true }).click();
  for (const file of files) {
    const image = parameters.getByRole("img", { name: file.name, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
  }
  await page.mouse.click(8, page.viewportSize()!.height - 8);
  await expect(parameters).not.toBeVisible();
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  const source = await page
    .getByRole("img", { name: files[0].name, exact: true })
    .getAttribute("src");
  const visitor = await browser.newContext();
  try {
    expect(
      (await visitor.request.get(new URL(source!, url).href)).status(),
    ).toBe(404);
    await page.goto(url);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await finishPublishing(page);
    expect(
      await (await visitor.request.get(new URL(source!, url).href)).body(),
    ).toEqual(files[0].buffer);
  } finally {
    await visitor.close();
  }
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("img", { name: files[1].name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("input_references");
  await expect(
    page.getByRole("button", {
      name: "Edit reference group title: Group 1",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Add input references", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Quality", exact: true })
    .selectOption("high");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  expect(
    await (await request.get("/fixture/image-requests")).json(),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("quality");
  await expect(
    page.getByRole("checkbox", { name: "high", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("img", { name: /shared-.*\.png/ })).toHaveCount(
    0,
  );
});

test("parameter compatibility grids isolate simultaneous warnings, unknown models, and dimensional conflicts", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/megapixels"
        ? { ...model, imageEndpoints: [] }
        : model,
    ),
  );
  await setup(page, false);
  const select = (name: string) =>
    page.getByRole("combobox", { name, exact: true });
  const table = (name: string) =>
    page.getByRole("table", { name: `${name} compatibility`, exact: true });
  await select("Rows").selectOption("quality");
  await page.getByRole("checkbox", { name: "low", exact: true }).check();
  await page.getByRole("checkbox", { name: "high", exact: true }).check();
  for (const model of ["Fixture image", "Fixture megapixels"])
    await page.getByRole("checkbox", { name: model, exact: true }).check();
  await select("Background").selectOption("transparent");
  await expect(table("Quality").getByRole("columnheader")).toHaveText([
    "Model",
    "low",
    "high",
  ]);
  await expect(table("Quality").getByRole("rowheader")).toHaveText([
    "Fixture image",
    "Fixture megapixels",
  ]);
  await expect(
    table("Quality").getByRole("cell", {
      name: "Fixture image / high: Supported",
      exact: true,
    }),
  ).toBeVisible();
  const low = table("Quality").getByRole("cell", {
    name: "Fixture image / low: Unsupported",
    exact: true,
  });
  await low.hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Unsupported quality: low.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    table("Quality").getByRole("cell", {
      name: "Fixture megapixels / high: Support unknown",
      exact: true,
    }),
  ).toBeVisible();
  await expect(table("Background").getByRole("columnheader")).toHaveText([
    "Model",
    "transparent",
  ]);
  await expect(
    table("Background").getByRole("cell", {
      name: "Fixture image / transparent: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(2);
  await select("Aspect ratio").selectOption("16:9");
  await expect(table("Aspect ratio").getByRole("columnheader")).toHaveText([
    "Model",
    "16:9",
  ]);
  await expect(page.getByRole("table")).toHaveCount(3);
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(table("Quality").getByRole("columnheader")).toHaveText([
    "Model",
    "low",
    "high",
  ]);
  await expect(table("Quality").getByRole("rowheader")).toHaveText([
    "Fixture image",
    "Fixture megapixels",
  ]);
  await select("Background").selectOption("opaque");
  await expect(table("Background")).toHaveCount(0);
  await select("Aspect ratio").selectOption("auto");
  await expect(table("Aspect ratio")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "low", exact: true }).uncheck();
  await expect(page.getByRole("table")).toHaveCount(0);
  await select("Size").selectOption("custom");
  await page.getByLabel("Custom size width", { exact: true }).fill("1536");
  await page.getByLabel("Custom size height", { exact: true }).fill("1024");
  await select("Aspect ratio").selectOption("1:1");
  await expect(page.getByRole("table")).toHaveCount(2);
  const mismatch = table("Aspect ratio").getByRole("cell", {
    name: "Fixture image / 1:1: Unsupported",
    exact: true,
  });
  await mismatch.hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Size 1536x1024 does not match aspect ratio 1:1.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    table("Size").getByRole("cell", {
      name: "Fixture image / 1536x1024: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await select("Aspect ratio").selectOption("3:2");
  await expect(page.getByRole("table")).toHaveCount(0);
});
