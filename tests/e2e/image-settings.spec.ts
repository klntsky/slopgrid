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
  const titles = page.getByRole("textbox", { name: "Reference group title" });
  await titles.nth(0).fill("Landscape");
  await titles.nth(0).press("Enter");
  await titles.nth(1).fill("Details");
  await titles.nth(1).press("Tab");
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
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  expect(uploads).toBe(0);
  await expect(titles.nth(0)).toHaveValue("Landscape");
  await expect(titles.nth(1)).toHaveValue("Details");
  // Rejected titles preserve both groups and their file associations.
  for (const invalid of ["Landscape", "   "]) {
    await titles.nth(1).fill(invalid);
    await titles.nth(1).press("Tab");
    await expect(titles.nth(1)).toHaveValue("Details");
    expect(uploads).toBe(0);
  }
  await titles.nth(1).fill("Details");
  await titles.nth(1).press("Tab");
  await page.getByRole("button", { name: "Swap rows and columns" }).click();
  await expect(
    page.getByRole("cell", { name: "1K / Details: Unsupported", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  expect(uploads).toBe(5);
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
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(titles.nth(0)).toHaveValue("Landscape");
  await expect(titles.nth(1)).toHaveValue("Details");
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "five.png" })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.goto(url);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expect(titles.nth(0)).toHaveValue("Landscape");
  await expect(titles.nth(1)).toHaveValue("Details");
  await expect(page.getByRole("img", { name: /\.png$/ })).toHaveCount(5);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  expect(uploads).toBe(5);
  expect(
    (await (await request.get("/fixture/image-requests")).json())
      .slice(2)
      .map((r: any) => r.input_references)
      .sort((a: any[], b: any[]) => a.length - b.length),
  ).toEqual(expected);
});
