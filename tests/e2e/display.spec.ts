import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

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
    await page.getByRole("button", { name: "Expand SVG", exact: true }).click();
    const expanded = page.getByRole("region", { name: /^Expanded output:/ });
    await expect(
      expanded.getByRole("img", { name: "SVG preview", exact: true }),
    ).toBeVisible();
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
      expanded.getByRole("img", { name: "Generated SVG", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Collapse SVG", exact: true })
      .click();
    await expect(expanded).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Expand SVG", exact: true }),
    ).toBeFocused();
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

for (const format of ["Image", "SVG"])
  test(`completed ${format} uses browser caching without sharing private entries between sessions`, async ({
    page,
    request,
    browser,
  }) => {
    await request.post("/fixture/reset", { data: {} });
    await create(page, format, "cat", "hat");
    await expectProgress(page, 1, 1);
    const gridURL = page.url();
    const source = await page
      .getByRole("img", {
        name: format === "SVG" ? "Generated SVG" : "Generated image",
        exact: true,
      })
      .getAttribute("src");
    const outputURL = new URL(source!, gridURL).href;
    await expect
      .poll(() =>
        page
          .locator(".generated-image")
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const ownerCookies = await page.context().cookies();
    async function cachedVisit(view: import("@playwright/test").Page) {
      await view.goto(new URL("/grids", gridURL).href);
      await view.goto(gridURL);
      await expect
        .poll(() =>
          view.evaluate((url) => {
            const entry = performance.getEntriesByName(url).at(-1) as
              PerformanceResourceTiming | undefined;
            return (
              entry && {
                transfer: entry.transferSize,
                decoded: entry.decodedBodySize > 0,
              }
            );
          }, outputURL),
        )
        .toEqual({ transfer: 0, decoded: true });
    }
    await cachedVisit(page);
    await page.context().clearCookies();
    const denied = await page.goto(outputURL);
    expect(denied!.status()).toBe(404);
    await page.context().addCookies(ownerCookies);
    await page.goto(gridURL);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await finishPublishing(page);
    const visitor = await browser.newContext();
    try {
      const shared = await visitor.newPage();
      await shared.goto(gridURL);
      await expect(
        shared.getByRole("img", {
          name: format === "SVG" ? "Generated SVG" : "Generated image",
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          shared
            .locator(".generated-image")
            .evaluate((el) => (el as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await visitor.clearCookies();
      await cachedVisit(shared);
    } finally {
      await visitor.close();
    }
  });

for (const format of ["Image", "SVG", "Markdown", "Static website"])
  test(`mouse panning respects ${format} content, controls and resize handles`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 800, height: 650 });
    await request.post("/fixture/reset", { data: {} });
    await create(page, format, "cat\ndog\nowl", "hat\ncape\nscarf");
    await expectProgress(page, 9, 9);
    const grid = page.getByLabel("Generated output grid");
    const cell = page.locator("article.cell").first();
    const handle = page.getByRole("separator", {
      name: "Resize column 1",
      exact: true,
    });
    for (let i = 0; i < 4; i++) await handle.press("Shift+ArrowRight");
    const position = () => grid.evaluate((el) => [el.scrollLeft, el.scrollTop]);
    const drag = async (x: number, y: number, dx = -70, dy = -60) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 6 });
      await page.mouse.up();
    };
    const image = format === "Image" || format === "SVG";
    const output = cell.locator(
      image
        ? "img"
        : format === "Markdown"
          ? ".markdown-preview"
          : "iframe:visible",
    );
    await expect(output).toBeVisible();
    if (image)
      await expect
        .poll(() =>
          output.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
    if (image || format === "Static website") {
      const source = await output.getAttribute("src");
      const mounted = await output.elementHandle();
      const expand = cell.getByRole("button", {
        name: `Expand ${format}`,
        exact: true,
      });
      const dimensions = await handle.getAttribute("aria-valuenow");
      await expand.click();
      const expanded = page.getByRole("region", { name: /^Expanded output:/ });
      if (image) {
        const expandedImage = expanded.getByRole("img");
        await expect(expandedImage).toHaveAttribute("src", source!);
        await expect
          .poll(() =>
            expandedImage.evaluate(
              (el) => (el as HTMLImageElement).naturalWidth,
            ),
          )
          .toBeGreaterThan(0);
      } else {
        const website = expanded.frameLocator("iframe:visible");
        await expect(website.getByText("Module loaded")).toBeVisible();
        await website.locator("body").click();
      }
      await page.keyboard.press("Escape");
      await expect(expanded).toHaveCount(0);
      await expect(expand).toBeFocused();
      expect(await mounted!.evaluate((el) => el.isConnected)).toBe(true);
      await expect(handle).toHaveAttribute("aria-valuenow", dimensions!);
    }
    if (format === "Static website")
      await expect(
        cell.frameLocator("iframe:visible").getByText("Module loaded"),
      ).toBeVisible();
    const content = (await output.boundingBox())!;
    await drag(content.x + content.width / 2, content.y + content.height / 2);
    expect(await position()).toEqual([0, 0]);
    const control = (await cell
      .getByRole("link", { name: "Open output", exact: true })
      .boundingBox())!;
    await drag(control.x + control.width / 2, control.y + control.height / 2);
    expect(await position()).toEqual([0, 0]);
    const surface = (await cell
      .locator(image ? ".image-preview" : ".cell-footer")
      .boundingBox())!;
    // Image padding starts the drag; pointer capture keeps it moving over content.
    await drag(surface.x + surface.width - 10, surface.y + surface.height / 2);
    await expect.poll(async () => (await position())[0]).toBeGreaterThan(50);
    await expect.poll(async () => (await position())[1]).toBeGreaterThan(40);
    const released = await position();
    await page.mouse.move(750, 100);
    expect(await position()).toEqual(released);
    await grid.evaluate((el) => el.scrollTo(0, 0));
    const width = Number(await handle.getAttribute("aria-valuenow"));
    const edge = (await handle.boundingBox())!;
    await drag(edge.x + edge.width / 2, edge.y + edge.height / 2, 60, 0);
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(
      width + 40,
    );
    expect(await position()).toEqual([0, 0]);
  });

test("theme follows system changes unless a saved choice overrides them", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(otherTab.locator("html")).toHaveAttribute("data-theme", "light");
  await otherTab.close();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(theme).toHaveValue("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const { width, hasTouch } of [
  { width: 390, hasTouch: false },
  { width: 1280, hasTouch: false },
  { width: 390, hasTouch: true },
  { width: 1280, hasTouch: true },
]) {
  test.describe(`navigation at ${width}px with touchscreen ${hasTouch}`, () => {
    test.use({ hasTouch });
    test("navigation uses touchscreen capability and preserves menu interactions", async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      const menu = page.getByRole("button", {
        name: "Navigation menu",
        exact: true,
      });
      const nav = page.getByRole("navigation");
      if (!hasTouch) {
        await expect(page.locator(".navigation-menu-toggle")).toHaveCount(0);
        await expect(nav).toBeVisible();
        await expect(
          page.getByRole("button", { name: /Switch to .* theme/ }),
        ).toBeVisible();
        await nav.getByRole("link", { name: "SETTINGS", exact: true }).click();
        await expect(page).toHaveURL("/settings");
        await expect(nav).toBeVisible();
        return;
      }
      await expect(
        page.getByRole("button", { name: /Switch to .* theme/ }),
      ).toBeHidden();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await expect(nav).toBeHidden();
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
      await page
        .getByRole("heading", { name: "Inference", exact: true })
        .click();
      await expect(nav).toBeHidden();
      await menu.click();
      await nav.getByRole("link", { name: "SETTINGS", exact: true }).click();
      await expect(page).toHaveURL("/settings");
      await expect(nav).toBeHidden();
    });
  });
}

test.describe("mobile grid interaction", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  for (const { layout, columns, total } of [
    { layout: "wide grid", columns: "hat\ncape\nscarf", total: 9 },
    { layout: "tall grid", columns: "hat", total: 3 },
  ])
    test(`pinching changes grid scale and one-finger scrolling still works (${layout})`, async ({
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
      const before = (await cell.boundingBox())!;
      await expect
        .poll(() =>
          grid.evaluate((viewport) =>
            Math.abs(
              viewport.querySelector("table")!.getBoundingClientRect().height -
                viewport.clientHeight,
            ),
          ),
        )
        .toBeLessThan(1);
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
      const top = await grid.evaluate((el) => el.scrollTop);
      const rowLabel = (await grid
        .locator("tbody > tr > th")
        .first()
        .boundingBox())!;
      const pan = {
        x: rowLabel.x + rowLabel.width / 2,
        y: rowLabel.y + rowLabel.height / 2,
        id: 1,
      };
      await touch("touchStart", [pan]);
      for (const distance of [20, 50, 80, 110])
        await touch("touchMove", [{ ...pan, y: pan.y - distance }]);
      await touch("touchEnd", []);
      await expect
        .poll(() => grid.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(top);
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
    });
});

test("keyboard resizing updates saved dimensions and restores them after reload", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const storageKey = `slopgrid:grid:${id}:sizes`;
  const initial = { columns: [500], rows: [3000] };
  await page.evaluate(
    ({ storageKey, initial }) => {
      localStorage.setItem(storageKey, JSON.stringify(initial));
    },
    { storageKey, initial },
  );
  await page.reload();
  const handle = page.getByRole("separator", {
    name: "Resize row 1",
    exact: true,
  });
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    String(initial.rows[0]),
  );
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    storageKey,
  );
  expect(saved.rows[0]).toBeGreaterThan(initial.rows[0]);
  expect(saved.columns).toEqual(initial.columns);
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", String(saved.rows[0]));
});

test("a missing grid reports 404 without retries or a creation link in the error state", async ({
  page,
}) => {
  const id = "0".repeat(48);
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/grids/${id}`) requests++;
  });
  await page.goto(`/grid/${id}`);
  await expect(page.getByRole("alert")).toHaveText("Grid not found");
  expect(requests).toBe(1);
  await expect(page.getByRole("main").getByRole("link")).toHaveCount(0);
});

test("Markdown preserves raw content and rendered structure across toggles and expansion", async ({
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
  const checkRaw = async () => {
    const preview = page.locator(".markdown-preview:visible");
    await expect(viewRaw).toHaveAttribute("aria-pressed", "true");
    expect(await preview.locator("pre").textContent()).toBe(markdown);
    await expect(preview.locator("code, p")).toHaveCount(0);
    const geometry = await preview.evaluate((view) => {
      const raw = view.querySelector("pre")!;
      return {
        fontSize: getComputedStyle(raw).fontSize,
        defaultFontSize: getComputedStyle(view).fontSize,
        rawScale: raw.getBoundingClientRect().width / raw.offsetWidth,
        viewScale: view.getBoundingClientRect().width / view.offsetWidth,
        contentWidth: raw.scrollWidth,
        availableWidth: raw.clientWidth,
        contentHeight: view.scrollHeight,
        availableHeight: view.clientHeight,
      };
    });
    expect(geometry.fontSize).toBe(geometry.defaultFontSize);
    expect(geometry.rawScale).toBeCloseTo(geometry.viewScale, 2);
    expect(geometry.contentWidth).toBeLessThanOrEqual(
      geometry.availableWidth + 1,
    );
    expect(geometry.contentHeight).toBeGreaterThan(geometry.availableHeight);
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
  await page.getByRole("button", { name: "View raw", exact: true }).click();
  const checkRendered = async () => {
    const preview = page.locator(".markdown-preview:visible");
    await expect(preview.locator("pre")).toHaveText(code);
    await expect(preview.locator("p")).toHaveText(
      "A paragraph after the code.",
    );
  };
  await checkRendered();
  await page
    .getByRole("button", { name: "Expand Markdown", exact: true })
    .click();
  await checkRendered();
  await viewRaw.click();
  await checkRaw();
  await page.getByRole("button", { name: "View raw", exact: true }).click();
  await checkRendered();
  await page
    .getByRole("button", { name: "Collapse Markdown", exact: true })
    .click();
  await checkRendered();
  await page.reload();
  await checkRendered();
});
