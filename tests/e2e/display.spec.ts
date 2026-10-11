import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

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
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await page.getByRole("link", { name: "NEW GRID", exact: true }).click();
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
  await theme.selectOption("light");
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

test.describe("mobile grid interaction", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("mobile navigation closes after navigation, Escape, or an outside click", async ({
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
    await expect(
      page.getByRole("button", { name: "View Markdown", exact: true }),
    ).toBeVisible();
    expect(await preview.locator("pre").textContent()).toBe(markdown);
    await expect(preview.locator("code, p")).toHaveCount(0);
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
  await page
    .getByRole("button", { name: "View Markdown", exact: true })
    .click();
  await checkRendered();
  await page
    .getByRole("button", { name: "Collapse Markdown", exact: true })
    .click();
  await checkRendered();
  await page.reload();
  await checkRendered();
});
