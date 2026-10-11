import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

test("row and column headers stay visible while scrolling a larger grid", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(
    page,
    "Static website",
    "cat\ndog\nowl",
    "hat\ncape\nscarf\ncrown",
  );
  await expectProgress(page, 12, 12);
  const viewport = page.getByLabel("Generated output grid");
  const column = page.getByRole("columnheader", { name: /^hat(?:\s|$)/ }),
    row = page.getByRole("rowheader", { name: /^cat(?:\s|$)/ });
  const beforeColumn = await column.boundingBox(),
    beforeRow = await row.boundingBox();
  await viewport.evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 400;
  });
  await expect
    .poll(async () => (await column.boundingBox())!.y)
    .toBe(beforeColumn!.y);
  await expect
    .poll(async () => (await row.boundingBox())!.x)
    .toBe(beforeRow!.x);
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("generation hints appear on keyboard focus before and after outputs finish", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    await create(page, "SVG", "cat", "hat");
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "Pause generation" }).focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Stops active requests. Work can be resumed later, unfinished responses will be lost.",
    );
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 1, 1);
    const tokens = page.locator(".token-count");
    await tokens.nth(0).focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Input tokens",
    );
    await tokens.nth(1).focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Output tokens",
    );
    await page.locator(".grid-cost").focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(
      page.locator('.tippy-box[data-state="visible"]'),
    ).toContainText("Completed output costs plus current estimates");
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("effort");
    await page
      .getByRole("checkbox", { name: "Model default", exact: true })
      .focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Uses the model’s default thinking settings.",
    );
    for (const axis of ["Rows", "Columns"]) {
      await page
        .getByRole("combobox", { name: axis, exact: true })
        .selectOption("variable");
    }
    await page
      .getByRole("combobox", { name: "Thinking effort", exact: true })
      .focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Uses the model’s default thinking settings.",
    );
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Draw $VARIABLE_ROW with $VARIABLE_COLUMN");
    await page.getByLabel("Budget limit per cell").focus();
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveCount(
      1,
    );
    await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
      "Used to calculate each output’s token limit.",
    );
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("SVG images grow during generation without exposing markup or running SVG scripts", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { svgStreaming: true } });
  try {
    await create(page, "SVG", "cat", "hat");
    const preview = page.getByRole("img", { name: "SVG preview", exact: true });
    const centerColor = () =>
      preview.evaluate((img) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 200;
        const context = canvas.getContext("2d")!;
        context.drawImage(img as HTMLImageElement, 0, 0, 200, 200);
        return [...context.getImageData(100, 100, 1, 1).data];
      });
    await expect(preview).toBeVisible();
    await expect.poll(centerColor).toEqual([255, 0, 0, 255]);
    await expectProgress(page, 0, 1);
    await page.reload();
    await expect.poll(centerColor).toEqual([255, 0, 0, 255]);
    await expect(page.getByRole("button", { name: "PUBLISH" })).toBeDisabled();
    await expect(page.locator("iframe, .cell pre")).toHaveCount(0);
    await request.post("/fixture/svg-next");
    await expect.poll(centerColor).toEqual([0, 0, 255, 255]);
    await expectProgress(page, 0, 1);
    expect(
      await page.evaluate(
        () => (window as Window & { unsafeOutput?: boolean }).unsafeOutput,
      ),
    ).toBeUndefined();
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "svg_escape",
    );
    expect(await (await request.get("/fixture/svg-probes")).json()).toEqual([]);
    await request.post("/fixture/svg-next");
    await expectProgress(page, 1, 1);
    await expect(preview).toHaveCount(0);
    await expect(
      page
        .locator(".cell-usage")
        .getByText("Cost unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Generated SVG", exact: true }),
    ).toBeVisible();
    const output = await page.request.get(
      (await page
        .getByRole("link", { name: "Open output" })
        .getAttribute("href"))!,
    );
    expect(await output.text()).toContain(
      '<circle cx="100" cy="100" r="70" fill="blue"/></g></svg>',
    );
    expect(await (await request.get("/fixture/calls")).json()).toHaveLength(1);
  } finally {
    await request.post("/fixture/reset", { data: {} });
  }
});

test("one completed image covers rendering, reload, and desktop/mobile workspace layouts", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  const prompt =
    "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN " +
    "with a carefully detailed background ".repeat(12);
  await create(page, "Image", "dog", "hat", prompt);
  await expectProgress(page, 1, 1);
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(
    page.locator(".cell-usage").getByText("$0.012345", { exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await expect(bar).toHaveAttribute("value", "1");
  const image = page.getByRole("img", { name: "Generated image" }).first();
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const output = await page
    .getByRole("link", { name: "Open output" })
    .first()
    .getAttribute("href");
  const response = await page.request.get(output!);
  expect(response.headers()["content-type"]).toContain("image/png");
  const gridURL = page.url();
  const viewports = [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ];
  async function expectActionsBesideTitle(names: string[], width: number) {
    const header = page.getByRole("banner");
    const title = (await header
      .getByRole("heading", { level: 1 })
      .boundingBox())!;
    for (const name of names) {
      const button = header.getByRole("button", { name, exact: true });
      const box = (await button.boundingBox())!;
      if (width > 700) {
        expect(box.x + box.width).toBeLessThanOrEqual(title.x);
        expect(box.y).toBeLessThan(title.y + title.height);
        expect(box.y + box.height).toBeGreaterThan(title.y);
      } else {
        expect(box.y + box.height).toBeLessThanOrEqual(title.y);
        const logo = (await header
          .getByRole("link", { name: "slopgrid", exact: true })
          .boundingBox())!;
        expect(box.y).toBeLessThan(logo.y + logo.height);
        expect(box.y + box.height).toBeGreaterThan(logo.y);
      }
      await expect(button.locator("svg")).toBeVisible();
    }
  }
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const header = page.getByRole("banner");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText(
      prompt.trim(),
    );
    await expect(
      header.getByRole("progressbar", { name: "Grid generation" }),
    ).toHaveAttribute("aria-valuetext", "1 of 1 outputs complete");
    await expect(header.getByRole("button", { name: "PUBLISH" })).toBeEnabled();
    if (viewport.width > 700) {
      expect(
        await header
          .getByRole("link", { name: "SETTINGS", exact: true })
          .evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          ),
      ).toBeGreaterThanOrEqual(16);
    }
    await expectActionsBesideTitle(["EDIT", "PUBLISH"], viewport.width);
    await expect(
      page.getByText("1 of 1 complete", { exact: true }),
    ).toHaveCount(0);
    const grid = page.getByLabel("Generated output grid");
    const headerBox = (await header.boundingBox())!,
      gridBox = (await grid.boundingBox())!;
    expect(gridBox.x).toBe(0);
    expect(gridBox.width).toBe(viewport.width);
    expect(gridBox.y).toBeCloseTo(headerBox.y + headerBox.height, 0);
    expect(gridBox.y + gridBox.height).toBeCloseTo(viewport.height, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
    const cornerCell = page.locator(".output-grid thead tr > :first-child");
    await expect(cornerCell).toHaveText("");
    await expect(cornerCell.locator("svg, img")).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: /^hat(?:\s|$)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("rowheader", { name: /^dog(?:\s|$)/ }),
    ).toBeVisible();
    const cell = (await page.locator(".cell").first().boundingBox())!,
      corner = (await cornerCell.boundingBox())!;
    const rowLabel = page.getByRole("rowheader", { name: /^dog(?:\s|$)/ });
    const contentWidth = (await rowLabel.locator(".row-label").boundingBox())!
      .width;
    const padding = await rowLabel.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderRightWidth)
      );
    });
    expect(corner.width).toBeCloseTo(contentWidth + padding, 0);
    expect(
      (await page.locator(".output-grid").boundingBox())!.width,
    ).toBeCloseTo(Math.max(viewport.width, 340 + corner.width), 0);
    expect(cell.width).toBeGreaterThanOrEqual(gridBox.width - corner.width - 2);
    expect(
      Math.abs(cell.y + cell.height - viewport.height),
    ).toBeLessThanOrEqual(2);
  }
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    if (page.url() !== gridURL) await page.goto(gridURL);
    const header = page.getByRole("banner");
    await expectActionsBesideTitle(["FORK", "Copy link"], viewport.width);
    await expect(header.getByText("Published", { exact: true })).toHaveCount(0);
    await header.getByRole("link", { name: "slopgrid", exact: true }).click();
    await page.getByRole("link", { name: "NEW GRID", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Create your own visual AI model benchmark",
      }),
    ).toBeVisible();
    await expect(header.getByRole("progressbar")).toHaveCount(0);
  }
});

test("theme follows system changes unless a saved choice overrides them", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await page.getByRole("link", { name: "NEW GRID", exact: true }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "SETTINGS", exact: true })
    .click();
  await expect(theme).toHaveValue("dark");
  const otherTab = await page.context().newPage();
  await otherTab.goto("/settings");
  await expect(
    otherTab.getByRole("combobox", { name: "Theme", exact: true }),
  ).toHaveValue("dark");
  await theme.selectOption("light");
  await expect(otherTab.locator("html")).toHaveCSS("color-scheme", "light");
  await otherTab.close();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(theme).toHaveValue("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
});

test("dark theme applies to generation controls, cell labels, and billing dialogs", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await request.post("/fixture/reset", { data: { billing: true } });
  await create(page);
  await expectProgress(page, 1, 2);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const backgrounds = await page
    .locator("html, .output-grid th, .cell-footer, dialog")
    .evaluateAll((elements) =>
      elements.map((el) => getComputedStyle(el).backgroundColor),
    );
  for (const color of backgrounds) {
    const channels = color.match(/[\d.]+/g)!.map(Number);
    if (channels[3] === 0) continue;
    expect(Math.max(...channels.slice(0, 3))).toBeLessThan(80);
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.locator(".cell-usage").getByText("$0.000123", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume generation" }),
  ).toBeEnabled();
});

test.describe("mobile grid interaction", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("the hamburger keeps navigation compact and closes after navigation or Escape", async ({
    page,
  }) => {
    await page.goto("/");
    const menu = page.getByRole("button", {
      name: "Navigation menu",
      exact: true,
    });
    const nav = page.getByRole("navigation");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(nav).toBeHidden();
    expect((await page.getByRole("banner").boundingBox())!.height).toBeLessThan(
      90,
    );
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await nav.getByRole("link", { name: "SETTINGS", exact: true }).click();
    await expect(page).toHaveURL("/settings");
    await expect(nav).toBeHidden();
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole("heading", { name: "Inference", exact: true }).click();
    await expect(nav).toBeHidden();
    await menu.click();
    await nav.getByRole("link", { name: "SETTINGS", exact: true }).click();
    await expect(page).toHaveURL("/settings");
    await expect(nav).toBeHidden();
  });

  for (const { layout, columns, total } of [
    { layout: "wide grid", columns: "hat\ncape\nscarf", total: 9 },
    { layout: "tall grid", columns: "hat", total: 3 },
  ])
    test(`pinching changes the table scale while the header stays fixed and one-finger scrolling still works (${layout})`, async ({
      page,
      request,
    }) => {
      await request.post("/fixture/reset", { data: { billing: false } });
      await create(page, "Static website", "cat\ndog\nowl", columns);
      await expectProgress(page, total, total);
      await expect(
        page
          .frameLocator("iframe")
          .first()
          .getByText("Module loaded", { exact: true }),
      ).toBeVisible();
      const grid = page.getByLabel("Generated output grid"),
        cell = page.locator(".cell").first(),
        header = page.getByRole("banner");
      const before = (await cell.boundingBox())!,
        headerBefore = (await header.boundingBox())!;
      expect((await grid.locator("table").boundingBox())!.width).toBeCloseTo(
        (await grid.boundingBox())!.width,
        0,
      );
      expect(await grid.evaluate((element) => element.scrollLeft)).toBe(0);
      const client = await page.context().newCDPSession(page);
      async function touch(
        type: "touchStart" | "touchMove" | "touchEnd",
        points: { x: number; y: number; id: number }[],
      ) {
        await client.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: points,
        });
      }
      expect(
        await grid.locator("table").evaluate((el) => el.style.height),
      ).toBe("");
      const headings = (await grid.locator("thead").boundingBox())!;
      const y = headings.y + headings.height / 2;
      await touch("touchStart", [
        { x: 220, y, id: 1 },
        { x: 320, y, id: 2 },
      ]);
      await touch("touchMove", [
        { x: 190, y, id: 1 },
        { x: 350, y, id: 2 },
      ]);
      await touch("touchEnd", []);
      await expect
        .poll(async () => (await cell.boundingBox())!.width)
        .toBeGreaterThan(before.width * 1.4);
      expect((await header.boundingBox())!.height).toBe(headerBefore.height);
      expect(
        await grid.locator("table").evaluate((el) => el.style.height),
      ).toBe("");
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
      const left = await grid.evaluate((el) => el.scrollLeft);
      await touch("touchStart", [{ x: 290, y, id: 1 }]);
      for (const nextX of [250, 200, 150, 100])
        await touch("touchMove", [{ x: nextX, y, id: 1 }]);
      await touch("touchEnd", []);
      await expect
        .poll(() => grid.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(left);
      await touch("touchStart", [
        { x: 190, y, id: 1 },
        { x: 350, y, id: 2 },
      ]);
      await touch("touchMove", [
        { x: 240, y, id: 1 },
        { x: 300, y, id: 2 },
      ]);
      await touch("touchEnd", []);
      await expect
        .poll(async () => (await cell.boundingBox())!.width)
        .toBeLessThan(before.width * 1.01);
      await expect(
        header.getByRole("button", { name: "PUBLISH" }),
      ).toBeEnabled();
      for (let attempt = 0; attempt < 2; attempt++) {
        await touch("touchStart", [
          { x: 190, y, id: 1 },
          { x: 350, y, id: 2 },
        ]);
        await touch("touchMove", [
          { x: 265, y, id: 1 },
          { x: 275, y, id: 2 },
        ]);
        await touch("touchEnd", []);
        const viewport = (await grid.boundingBox())!,
          table = (await grid.locator("table").boundingBox())!;
        const fit = table.width / viewport.width;
        expect(fit).toBeGreaterThanOrEqual(0.99);
        expect(fit).toBeLessThanOrEqual(1.01);
      }
      await page.setViewportSize({ width: 430, height: 844 });
      await expect
        .poll(async () =>
          Math.abs(
            (await grid.locator("table").boundingBox())!.width -
              (await grid.boundingBox())!.width,
          ),
        )
        .toBeLessThan(1);
      await page.setViewportSize({ width: 1280, height: 844 });
      await expect
        .poll(() =>
          grid
            .locator("table")
            .evaluate((element) => getComputedStyle(element).zoom),
        )
        .toBe("1");
    });
});

test("saved output row sizes do not stretch the table header", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const heading = page.locator(".output-grid thead");
  const originalHeight = (await heading.boundingBox())!.height;
  expect(originalHeight).toBeLessThanOrEqual(70);
  const viewport = page.getByLabel("Generated output grid");
  await expect
    .poll(async () =>
      Math.abs(
        (await page.locator(".output-grid").boundingBox())!.height -
          (await viewport.boundingBox())!.height,
      ),
    )
    .toBeLessThan(2);
  await page.setViewportSize({ width: 1280, height: 2000 });
  await expect
    .poll(async () =>
      Math.abs(
        (await page.locator(".output-grid").boundingBox())!.height -
          (await viewport.boundingBox())!.height,
      ),
    )
    .toBeLessThan(2);
  expect((await heading.boundingBox())!.height).toBeCloseTo(originalHeight, 0);
  await expect(heading.locator('[data-resize-axis="rows"]')).toHaveCount(0);
  await page.evaluate((gridId) => {
    localStorage.setItem(
      `slopgrid:grid:${gridId}:sizes`,
      JSON.stringify({ columns: [500], rows: [3000] }),
    );
  }, id);
  await page.reload();
  await expectProgress(page, 1, 1);
  expect((await heading.boundingBox())!.height).toBeCloseTo(originalHeight, 0);
  expect(
    (await page.locator(".output-grid tbody tr").boundingBox())!.height,
  ).toBeCloseTo(3000, 0);
  const handle = page.getByRole("separator", {
    name: "Resize row 1",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  expect((await heading.boundingBox())!.height).toBeCloseTo(originalHeight, 0);
  await page.reload();
  await expectProgress(page, 1, 1);
  expect((await heading.boundingBox())!.height).toBeCloseTo(originalHeight, 0);
  expect(
    (await page.locator(".output-grid tbody tr").boundingBox())!.height,
  ).toBeCloseTo(3010, 0);
});

test("model IDs in row and column labels copy to the real clipboard", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  for (const [axis, model] of [
    ["row", "fixture/text"],
    ["column", "fixture/other"],
  ] as const) {
    const response = await page.request.post("/api/grids", {
      data: {
        format: "svg",
        prompt: "Draw a cat",
        rows:
          axis === "row"
            ? { kind: "model", values: [model] }
            : { kind: "effort", values: ["none"] },
        columns:
          axis === "column"
            ? { kind: "model", values: [model] }
            : { kind: "effort", values: ["none"] },
        model,
        effort: "none",
        budgetUsd: 5,
      },
    });
    expect(response.status()).toBe(201);
    await page.goto(`/grid/${(await response.json()).id}`);
    await expectProgress(page, 1, 1);
    await page
      .getByRole(axis === "row" ? "rowheader" : "columnheader")
      .getByRole("button", { name: `Copy model ID ${model}`, exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(model);
    await expect(page.getByText("Model ID copied", { exact: true })).toHaveText(
      "Model ID copied",
    );
  }
});

test("a missing grid reports 404 immediately without retries or a creation link in the error state", async ({
  page,
}) => {
  const id = "0".repeat(48);
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/grids/${id}`) requests++;
  });
  await page.goto(`/grid/${id}`);
  await expect(page.getByRole("alert")).toHaveText("Grid not found", {
    timeout: 1000,
  });
  expect(requests).toBe(1);
  await expect(page.getByRole("main").getByRole("link")).toHaveCount(0);
});

test("Markdown toggles raw text in place, preserves the view on expansion, and fits rendered code", async ({
  page,
  request,
}) => {
  const line = "const longExample = " + "abcdefghij".repeat(24) + ";";
  const code = Array(300).fill(line).join("\n") + "\n";
  const markdown = "```js\n" + code + "```\n\nA paragraph after the code.";
  await request.post("/fixture/reset", { data: { markdownOutput: markdown } });
  await create(page, "Markdown", "cat", "hat");
  await expectProgress(page, 1, 1);
  const viewRaw = page.getByRole("button", { name: "View raw", exact: true });
  const rawBounds = (await viewRaw.boundingBox())!;
  const expandBounds = (await page
    .getByRole("button", { name: "Expand Markdown", exact: true })
    .boundingBox())!;
  expect(rawBounds.x + rawBounds.width).toBeLessThanOrEqual(expandBounds.x);
  const checkRaw = async () => {
    const preview = page.locator(".markdown-preview:visible");
    await expect(
      page.getByRole("button", { name: "View Markdown", exact: true }),
    ).toBeVisible();
    expect(await preview.locator("pre").textContent()).toBe(markdown);
    await expect(preview.locator("code, p")).toHaveCount(0);
    expect(
      await preview.evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth + 1 &&
          el.scrollHeight > el.clientHeight,
      ),
    ).toBe(true);
  };
  await viewRaw.click();
  await checkRaw();
  await page
    .getByRole("button", { name: "Expand Markdown", exact: true })
    .click();
  await checkRaw();
  await page
    .getByRole("button", { name: "Collapse Markdown", exact: true })
    .click();
  await checkRaw();
  await page
    .getByRole("button", { name: "View Markdown", exact: true })
    .click();
  const checkFit = async () => {
    const preview = page.locator(".markdown-preview:visible");
    await expect(preview.locator("pre")).toHaveText(code);
    await expect(preview.locator("p")).toHaveText(
      "A paragraph after the code.",
    );
    await expect
      .poll(() =>
        preview.evaluate((el) => {
          const doc = el.querySelector<HTMLElement>(".markdown-document")!;
          const pre = doc.querySelector("pre")!;
          const bounds = el.getBoundingClientRect();
          const code = pre.getBoundingClientRect();
          return (
            el.scrollWidth <= el.clientWidth + 1 &&
            pre.scrollWidth <= pre.clientWidth + 1 &&
            code.right <= bounds.right + 1 &&
            Number(doc.style.zoom) < 1
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() => preview.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    await preview.evaluate((el) => {
      el.scrollTop = 80;
      el.scrollLeft = 80;
    });
    await expect
      .poll(() => preview.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    expect(await preview.evaluate((el) => el.scrollLeft)).toBe(0);
  };
  await checkFit();
  await page
    .getByRole("button", { name: "Expand Markdown", exact: true })
    .click();
  await checkFit();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkFit();
  await viewRaw.click();
  await checkRaw();
  await page
    .getByRole("button", { name: "View Markdown", exact: true })
    .click();
  await checkFit();
  await page
    .getByRole("button", { name: "Collapse Markdown", exact: true })
    .click();
  await checkFit();
  await page.reload();
  await checkFit();
});
