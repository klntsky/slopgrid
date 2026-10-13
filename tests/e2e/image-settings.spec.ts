import { test, expect } from "./fixtures";
import { finishPublishing, expectProgress } from "./helpers";

async function setup(page: import("@playwright/test").Page, connect = true) {
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  if (connect) {
    await page.getByRole("link", { name: "Connect OpenRouter" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  }
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
}

test("image warnings follow axis orientation and remain advisory, while custom sizes and settings reach inference", async ({
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
    name: "Image settings compatibility",
  });
  await expect(
    table.getByRole("cell", {
      name: "low / Fixture image: Unsupported",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    table.getByRole("cell", {
      name: "high / Fixture image: Supported",
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
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("fixture/image");
  await page
    .getByRole("checkbox", { name: "transparent", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "opaque", exact: true }).check();
  await page.getByRole("checkbox", { name: "low", exact: true }).uncheck();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  let sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent.map((r: any) => [r.quality, r.background]).sort()).toEqual([
    ["high", "opaque"],
    ["high", "transparent"],
  ]);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await rows.selectOption("size");
  await columns.selectOption("aspect_ratio");
  await page.getByRole("checkbox", { name: "2K", exact: true }).check();
  await page.getByLabel("Custom rows size").fill("1536x1024");
  await page.getByRole("button", { name: "Add size", exact: true }).click();
  await page.getByRole("checkbox", { name: "3:2", exact: true }).check();
  await expect(table).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
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
  ]);
});

test("renamed reference groups survive reload, Edit and Fork without mixing their files", async ({
  page,
  request,
  browser,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await setup(page, false);
  let uploads = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      new URL(req.url()).pathname === "/api/references"
    )
      uploads++;
  });
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("input_references");
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("size");
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("fixture/image");
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
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Add images to every reference group",
  );
  expect(uploads).toBe(0);
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
    name: "Details / 1K: Unsupported",
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
  expect(uploads).toBe(0);
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  expect(uploads).toBe(0);
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
    expect(uploads).toBe(0);
  }
  await titles.nth(1).click();
  await titleField.fill("Discard this edit");
  await titleField.press("Escape");
  await expect(titles.nth(1)).toBeFocused();
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(
    page.getByRole("cell", { name: "1K / Details: Unsupported", exact: true }),
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
  expect(uploads).toBe(6);
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
  expect(uploads).toBe(6);
  expect(
    (await (await request.get("/fixture/image-requests")).json())
      .slice(2)
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
  await expect(tip).toContainText("Fixture provider");
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("quality");
  await page.getByRole("checkbox", { name: "low", exact: true }).check();
  await expect(
    page.getByRole("cell", {
      name: "low / Fixture image: Unsupported",
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
});
