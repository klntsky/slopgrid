import { test, expect } from "@playwright/test";

async function expectProgress(
  page: import("@playwright/test").Page,
  completed: number,
  total: number,
) {
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("value", String(completed));
  await expect(bar).toHaveAttribute("max", String(total));
}

async function create(
  page: import("@playwright/test").Page,
  format = "SVG",
  rows = "cat\ndog",
  columns = "hat",
  harness = "direct",
  prompt = "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
  model?: string,
) {
  await page.goto("/");
  await page.getByRole("button", { name: format, exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await page.getByLabel("Row values").fill(rows);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByLabel("Column values").fill(columns);
  if (model)
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption(model);
  if (format !== "Image")
    await page
      .getByRole("combobox", { name: "Harness", exact: true })
      .selectOption(harness);
  await page.getByRole("button", { name: "Continue to prompt" }).click();
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Continue to key setup" }).click();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("OpenRouter connected")).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}

test("billing can be dismissed and retried repeatedly without regenerating completed cells; publishing survives reload", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: true } });
  await create(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectProgress(page, 1, 2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Resume generation", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(async () => {
      const calls = await (await request.get("/fixture/calls")).json();
      return calls.filter((p: string) => p.includes("dog")).length;
    })
    .toBe(2);
  await request.post("/fixture/credits");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Retry unfinished cells" })
    .click();
  await expectProgress(page, 2, 2);
  await page.getByRole("button", { name: "PUBLISH" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const url = page.url();
  const stranger = await page.context().browser()!.newContext();
  const publicPage = await stranger.newPage();
  await publicPage.goto(url);
  await expectProgress(publicPage, 2, 2);
  await expect(
    publicPage.getByText("$0.000123 USD", { exact: true }),
  ).toHaveCount(2);
  await expect(publicPage.getByRole("button", { name: "PUBLISH" })).toHaveCount(
    0,
  );
  await stranger.close();
  const calls = await (await request.get("/fixture/calls")).json();
  expect(calls.filter((p: string) => p.includes("cat")).length).toBe(1);
  expect(calls.filter((p: string) => p.includes("dog")).length).toBe(3);
});

for (const format of ["SVG", "Markdown", "Static website", "Image"])
  test(`${format} renders generated output`, async ({ page, request }) => {
    await request.post("/fixture/reset", { data: { billing: false } });
    await create(page, format);
    await expectProgress(page, 2, 2);
    if (format === "Image") {
      await expect(page.getByText("$0.00 USD", { exact: true })).toHaveCount(1);
      await expect(
        page.getByText("$0.012345 USD", { exact: true }),
      ).toHaveCount(1);
    } else {
      await expect(
        page.getByText("$0.000123 USD", { exact: true }),
      ).toHaveCount(2);
    }
    await page.reload();
    await expectProgress(page, 2, 2);
    await expect(
      page.getByText(format === "Image" ? "$0.012345 USD" : "$0.000123 USD", {
        exact: true,
      }),
    ).toHaveCount(format === "Image" ? 1 : 2);
    const output = new URL(
      (await page
        .getByRole("link", { name: "Open output" })
        .first()
        .getAttribute("href"))!,
    );
    if (format === "Static website")
      expect(output.hostname).toMatch(/^[a-f0-9]{48}-slopgrid\.localhost$/);
    else {
      expect(output.origin).toBe("http://localhost:4317");
      expect(output.pathname).toMatch(/^\/outputs\/[a-f0-9]{48}$/);
      const cellId = output.pathname.split("/").pop();
      expect(
        (
          await request.get("/index.html", {
            headers: { host: `${cellId}-slopgrid.localhost:4317` },
          })
        ).status(),
      ).toBe(404);
    }
    if (format === "Image" || format === "SVG") {
      const image = page
        .getByRole("img", {
          name: format === "SVG" ? "Generated SVG" : "Generated image",
        })
        .first();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      const response = await request.get(output.href);
      expect(response.headers()["content-type"]).toContain(
        format === "SVG" ? "image/svg+xml" : "image/png",
      );
      expect(response.headers()["set-cookie"]).toBeUndefined();
      await expect(page.locator("iframe")).toHaveCount(0);
    } else {
      const frame = page.frameLocator("iframe").first();
      if (format === "Markdown")
        await expect(
          frame.getByRole("heading", { name: "A generated cat" }),
        ).toBeVisible();
      if (format === "Static website") {
        await expect(frame.getByText("Module loaded")).toBeVisible();
        await expect(
          frame.getByRole("heading", { name: "A generated site" }),
        ).toBeVisible();
        await expect(frame.locator("body")).toHaveCSS(
          "background-color",
          "rgb(255, 0, 0)",
        );
      }
    }
  });

test("drafts, mutation endpoints, and generated hosts enforce ownership and origin boundaries", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Static website");
  await expectProgress(page, 2, 2);
  const id = page.url().split("/").pop();
  const anonymous = await (
    await import("@playwright/test")
  ).request.newContext({ baseURL: "http://localhost:4317" });
  expect((await anonymous.get(`/api/grids/${id}`)).status()).toBe(404);
  expect((await anonymous.post(`/api/grids/${id}/publish`)).status()).toBe(404);
  expect(
    (
      await request.post(`/api/grids/${id}/publish`, {
        headers: { origin: "https://evil.example" },
      })
    ).status(),
  ).toBe(403);
  const output = await page.locator("iframe").first().getAttribute("src");
  const isolated = new URL(output!);
  expect(isolated.hostname).toMatch(/^[a-f0-9]{48}-slopgrid\.localhost$/);
  const response = await request.get(
    `http://localhost:4317${isolated.pathname}`,
    { headers: { host: isolated.host } },
  );
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(response.headers()["content-security-policy"]).toContain("sandbox");
  expect(
    (
      await request.get("http://localhost:4317/api/session", {
        headers: { host: isolated.host },
      })
    ).status(),
  ).toBe(404);
  const cellId = isolated.hostname.split("-")[0];
  expect((await request.get(`/outputs/${cellId}`)).status()).toBe(404);
  // A direct output tab must be isolated too, without relying on the iframe sandbox.
  const outputTab = await page.context().newPage();
  await outputTab.goto(output!);
  expect(
    await outputTab.evaluate(() => {
      try {
        document.cookie = "sibling-cookie=secret;domain=localhost";
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await outputTab.close();
  await anonymous.dispose();
});

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
  const column = page.getByRole("columnheader", { name: "hat", exact: true }),
    row = page.getByRole("rowheader", { name: "cat", exact: true });
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

test("settings connects and disconnects OpenRouter without exposing a key to the browser", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("OpenRouter connected")).toBeVisible();
  const session = await page.evaluate(
    async () => await (await fetch("/api/session")).json(),
  );
  expect(session).toEqual({ connected: true });
  await page.getByRole("button", { name: "Disconnect OpenRouter" }).click();
  await expect(
    page.getByRole("link", { name: "Connect OpenRouter" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Connect OpenRouter" }),
  ).toBeVisible();
});

test("OAuth rejects a forged callback", async ({ request }) => {
  const start = await request.get("/api/auth/start", { maxRedirects: 0 });
  const auth = new URL(start.headers().location);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(
    (await request.get("/api/auth/callback?code=forged&state=wrong")).status(),
  ).toBe(400);
  expect(await (await request.get("/api/session")).json()).toEqual({
    connected: false,
  });
});

for (const format of ["Image", "SVG"])
  test(`${format} billing errors pause unfinished work, including streamed errors`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", {
      data: { billing: true, streamBilling: format === "SVG" },
    });
    await create(page, format);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectProgress(page, 1, 2);
    await request.post("/fixture/credits");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retry unfinished cells" })
      .click();
    await expectProgress(page, 2, 2);
    const calls = await (await request.get("/fixture/calls")).json();
    expect(calls.filter((p: string) => p.includes("cat"))).toHaveLength(1);
  });

test("draft and review makes a second request for each cell and renders the final output", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Markdown", "cat\ndog", "hat", "review");
  await expectProgress(page, 2, 2);
  await expect(
    page
      .frameLocator("iframe")
      .first()
      .getByRole("heading", { name: "A generated cat" }),
  ).toBeVisible();
  await expect(page.getByText("$0.000246 USD", { exact: true })).toHaveCount(2);
  const calls = await (await request.get("/fixture/calls")).json();
  expect(calls).toHaveLength(4);
  expect(
    calls.filter((p: string) => p.includes("Check the draft")),
  ).toHaveLength(2);
});

test("a missing review charge is shown as unavailable rather than a partial cost", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { billing: false, omitReviewCost: true },
  });
  await create(page, "Markdown", "cat", "hat", "review");
  await expectProgress(page, 1, 1);
  await expect(page.getByText("20 in · 40 out", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Cost unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$0.000123 USD", { exact: true })).toHaveCount(0);
});

for (const format of ["SVG", "Markdown"])
  test(`${format} on the app host cannot execute generated scripts or access cookies`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", {
      data: { billing: false, unsafe: true },
    });
    await create(page, format);
    await expectProgress(page, 2, 2);
    if (format === "SVG") {
      const image = page.getByRole("img", { name: "Generated SVG" }).first();
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(page.locator("iframe")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => (window as Window & { unsafeOutput?: boolean }).unsafeOutput,
        ),
      ).toBeUndefined();
      expect(await page.evaluate(() => document.cookie)).not.toContain(
        "svg_escape",
      );
      expect(await (await request.get("/fixture/svg-probes")).json()).toEqual(
        [],
      );
    }
    const output = (await page
      .getByRole("link", { name: "Open output" })
      .first()
      .getAttribute("href"))!;
    expect(new URL(output).origin).toBe("http://localhost:4317");
    const tab = await page.context().newPage();
    await tab.goto(output);
    expect(
      await tab.evaluate(
        () => (window as Window & { unsafeOutput?: boolean }).unsafeOutput,
      ),
    ).toBeUndefined();
    expect(
      await tab.evaluate(() => {
        try {
          void document.cookie;
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    if (format === "Markdown")
      await expect(tab.locator("script")).toHaveCount(0);
    expect(await (await request.get("/fixture/svg-probes")).json()).toEqual([]);
    await tab.close();
  });

test("model choices start empty and filtering preserves deliberate selections", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Create a grid to compare models and their settings",
    }),
  ).toBeVisible();
  await expect(page.getByText("CREATE A GRID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  const columns = page.getByRole("group", { name: "Column values" });
  await expect(columns.locator("label.checkbox")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  await expect(page.getByPlaceholder("Filter column models")).toBeVisible();
  await expect(page.getByText("Row values", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Filter column models", { exact: true }),
  ).toHaveCount(0);
  await columns
    .getByRole("checkbox", { name: "Fixture text", exact: true })
    .check();
  await page.getByLabel("Filter column models").fill("FIXTURE/OTHER");
  await expect(columns.getByRole("checkbox")).toHaveCount(1);
  await columns.getByRole("checkbox", { name: "Second model" }).check();
  await page.getByLabel("Filter column models").fill("no matching model");
  await expect(columns.getByText("No models match your filter.")).toBeVisible();
  await page.getByLabel("Filter column models").fill("");
  await expect(
    columns.getByRole("checkbox", { name: "Fixture text", exact: true }),
  ).toBeChecked();
  await expect(
    columns.getByRole("checkbox", { name: "Second model" }),
  ).toBeChecked();
  expect(
    (await columns.locator(".value-list").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(264);
  for (const kind of ["harness", "model", "effort"]) {
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption(kind);
    await expect(
      page.getByRole("group", { name: "Row values" }).locator("input:checked"),
    ).toHaveCount(0);
  }
});

test("unused prompt variables block setup, later edits block generation, and the API rejects bypasses", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByRole("button", { name: "Continue to prompt" }).click();
  for (const prompt of ["Draw a cat", "$VARIABLE_ROW", "$VARIABLE_COLUMN"]) {
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Continue to key setup" }).click();
    await expect(page.getByRole("heading", { name: "Key setup" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("alert")).toContainText("Include $VARIABLE_");
  }
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("$VARIABLE_ROW $VARIABLE_COLUMN");
  await page.getByRole("button", { name: "Continue to key setup" }).click();
  const connect = page.getByRole("link", { name: "Connect OpenRouter" });
  await expect(connect.locator("img")).toBeVisible();
  await connect.click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Prompt", { exact: true }).fill("$VARIABLE_ROW");
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  const response = await page.request.post("/api/grids", {
    data: {
      format: "image",
      prompt: "$VARIABLE_ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "variable", values: ["hat"] },
      model: "fixture/image",
      effort: "none",
      harness: "direct",
    },
  });
  expect(response.status()).toBe(400);
  expect(await (await request.get("/fixture/calls")).json()).toEqual([]);
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("$VARIABLE_ROW $VARIABLE_COLUMN");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 4, 4);
  await expect(page.getByText("Image GRID", { exact: true })).toHaveCount(0);
});

test("the logo opens the form for a new browser and Your grids after creation", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/settings");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await expect(page).toHaveURL("/");
  const navbar = page.getByRole("navigation");
  await navbar.getByRole("link", { name: "YOUR GRIDS" }).click();
  await expect(page).toHaveURL("/grids");
  await expect(page.getByRole("heading", { name: "Your grids" })).toBeVisible();
  await expect(
    page.getByText("You haven’t created any grids yet."),
  ).toBeVisible();
  await navbar.getByRole("link", { name: "NEW GRID", exact: true }).click();
  await expect(page).toHaveURL("/");
  await create(page, "Image", "cat", "hat");
  await expectProgress(page, 1, 1);
  const gridURL = page.url();
  await navbar.getByRole("link", { name: "NEW GRID", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your grids" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await expect(page).toHaveURL("/grids");
  await page.reload();
  await page
    .getByRole("link", {
      name: "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN complete",
    })
    .click();
  await expect(page).toHaveURL(gridURL);
});

test("the prompt step removes redundant controls while keeping an accessible prompt", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await page.getByRole("button", { name: "Continue to prompt" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter your prompt" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to prompt" }),
  ).toHaveCount(0);
  await expect(page.getByText("Prompt", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("$VARIABLE_ROW $VARIABLE_COLUMN");
  await page.getByRole("button", { name: "Continue to key setup" }).click();
  await expect(page.getByRole("heading", { name: "Key setup" })).toBeVisible();
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
      page.getByText("Cost unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Generated SVG", exact: true }),
    ).toBeVisible();
    const output = await request.get(
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

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])
  test(`grid header and full-page workspace stay usable at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await request.post("/fixture/reset", { data: { billing: false } });
    const prompt =
      "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN " +
      "with a carefully detailed background ".repeat(12);
    await create(page, "Image", "cat", "hat", "direct", prompt);
    await expectProgress(page, 1, 1);
    const header = page.getByRole("banner");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText(
      prompt.trim(),
    );
    await expect(
      header.getByRole("progressbar", { name: "Grid generation" }),
    ).toHaveAttribute("aria-valuetext", "1 of 1 outputs complete");
    await expect(header.getByRole("button", { name: "PUBLISH" })).toBeEnabled();
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
    const legend = page.getByRole("columnheader", { name: "Grid dimensions" });
    await expect(legend.getByText("Columns", { exact: true })).toBeVisible();
    await expect(legend.getByText("Rows", { exact: true })).toBeVisible();
    const columns = (await legend
        .getByText("Columns", { exact: true })
        .boundingBox())!,
      rows = (await legend.getByText("Rows", { exact: true }).boundingBox())!;
    expect(rows.y).toBeGreaterThan(columns.y + columns.height);
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Generated image", exact: true })
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const cell = (await page.locator(".cell").first().boundingBox())!,
      corner = (await legend.boundingBox())!;
    expect(cell.width).toBeGreaterThanOrEqual(gridBox.width - corner.width - 2);
    expect(
      Math.abs(cell.y + cell.height - viewport.height),
    ).toBeLessThanOrEqual(2);
    await header.getByRole("button", { name: "PUBLISH" }).click();
    await expect(header.getByText("Published", { exact: true })).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Copy link" }),
    ).toBeVisible();
    if (viewport.width <= 700)
      await header
        .getByRole("button", { name: "Navigation menu", exact: true })
        .click();
    await header
      .getByRole("navigation")
      .getByRole("link", { name: "NEW GRID", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Create a grid to compare models and their settings",
      }),
    ).toBeVisible();
    await expect(header.getByRole("progressbar")).toHaveCount(0);
  });

test("parallel generation queues users and gives freed slots to users with fewer workers", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  const browser = page.context().browser()!,
    baseURL = test.info().project.use.baseURL;
  const bobContext = await browser.newContext({ baseURL }),
    carolContext = await browser.newContext({ baseURL });
  const bob = await bobContext.newPage(),
    carol = await carolContext.newPage();
  const calls = async (): Promise<string[]> =>
    (await request.get("/fixture/calls")).json();
  try {
    await create(page, "Image", "A0\nA1\nA2\nA3", "hat");
    await expect.poll(async () => (await calls()).length).toBe(2);
    await create(bob, "Image", "B0\nB1\nB2", "hat");
    await create(carol, "Image", "C0\nC1\nC2", "hat");
    await expectProgress(bob, 0, 3);
    await expectProgress(carol, 0, 3);
    expect(await calls()).toHaveLength(2);
    await request.post("/fixture/release", {
      data: { prompt: (await calls())[0] },
    });
    await expect.poll(async () => (await calls()).length).toBe(3);
    expect((await calls())[2]).toContain("Draw B0 ");
    await expectProgress(page, 1, 4);
    await request.post("/fixture/release", {
      data: { prompt: (await calls())[1] },
    });
    await expect.poll(async () => (await calls()).length).toBe(4);
    expect((await calls())[3]).toContain("Draw C0 ");
    const workers = await (await request.get("/fixture/workers")).json();
    expect(workers.held).toHaveLength(2);
    expect(workers.aborted).toEqual([]);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 4, 4);
    await expectProgress(bob, 3, 3);
    await expectProgress(carol, 3, 3);
    expect(await calls()).toHaveLength(10);
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
    await bobContext.close();
    await carolContext.close();
  }
});

test("Pause aborts active inference and releases slots; Resume preserves completed images", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    await create(page, "Image", "cat\ndog\nowl", "hat");
    const calls = async (): Promise<string[]> =>
      (await request.get("/fixture/calls")).json();
    await expect.poll(async () => (await calls()).length).toBe(2);
    await request.post("/fixture/release", {
      data: { prompt: (await calls()).find((p) => p.includes("cat")) },
    });
    await expectProgress(page, 1, 3);
    await expect.poll(async () => (await calls()).length).toBe(3);
    const header = page.getByRole("banner"),
      pause = header.getByRole("button", { name: "Pause generation" });
    const titleBox = (await header
        .getByRole("heading", { level: 1 })
        .boundingBox())!,
      pauseBox = (await pause.boundingBox())!;
    expect(pauseBox.x + pauseBox.width).toBeLessThanOrEqual(titleBox.x);
    const bar = header.getByRole("progressbar", { name: "Grid generation" }),
      barBox = (await bar.boundingBox())!,
      headerBox = (await header.boundingBox())!;
    expect(barBox.x).toBe(0);
    expect(barBox.width).toBe(headerBox.width);
    expect(barBox.height).toBeLessThanOrEqual(3);
    expect(
      Math.abs(barBox.y + barBox.height - headerBox.y - headerBox.height),
    ).toBeLessThanOrEqual(2);
    const spark = header.locator(".progress-spark");
    await expect(spark).toBeVisible();
    const sparkStart = (await spark.boundingBox())!.x;
    await expect
      .poll(async () => Math.abs((await spark.boundingBox())!.x - sparkStart))
      .toBeGreaterThan(4);
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const anonymous = await request.post(`/api/grids/${id}/pause`);
    expect(anonymous.status()).toBe(404);
    const crossOrigin = await page.request.post(`/api/grids/${id}/pause`, {
      headers: { origin: "https://attacker.invalid" },
    });
    expect(crossOrigin.status()).toBe(403);
    await pause.click();
    await expect(
      header.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    await expect(header.locator(".progress-spark")).toHaveCount(0);
    await expectProgress(page, 1, 3);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).aborted.length,
      )
      .toBe(2);
    const snapshot = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(snapshot.interruption).toBe("manual");
    expect(
      snapshot.cells.filter((c: { status: string }) => c.status === "running"),
    ).toHaveLength(0);
    expect(snapshot.cells.every((c: { draft?: string }) => !c.draft)).toBe(
      true,
    );
    await header.getByRole("button", { name: "Resume generation" }).click();
    await expect(
      header.getByRole("button", { name: "Pause generation" }),
    ).toBeVisible();
    await expect.poll(async () => (await calls()).length).toBe(5);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
    expect((await calls()).filter((p) => p.includes("cat"))).toHaveLength(1);
    await expect(header.locator(".progress-spark")).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "Pause generation" }),
    ).toHaveCount(0);
    await header.getByRole("button", { name: "PUBLISH" }).click();
    expect((await page.request.post(`/api/grids/${id}/pause`)).status()).toBe(
      409,
    );
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("pausing a streamed SVG discards its partial image and Resume generates it again", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { svgStreaming: true } });
  try {
    await create(page, "SVG", "cat", "hat");
    const preview = page.getByRole("img", { name: "SVG preview", exact: true });
    await expect(preview).toBeVisible();
    await page.getByRole("button", { name: "Pause generation" }).click();
    await expect(preview).toHaveCount(0);
    await expectProgress(page, 0, 1);
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect(preview).toBeVisible();
    expect(await (await request.get("/fixture/calls")).json()).toHaveLength(2);
    await request.post("/fixture/svg-next");
    await expect
      .poll(() => preview.getAttribute("src"))
      .toContain("fill%3D%22blue");
    await request.post("/fixture/svg-next");
    await expectProgress(page, 1, 1);
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
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "NEW GRID", exact: true })
    .click();
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
  await expect(page.getByText("$0.000123 USD", { exact: true })).toBeVisible();
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
    await nav.getByRole("link", { name: "NEW GRID", exact: true }).click();
    await expect(page).toHaveURL("/");
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
      const y = Math.max(headerBefore.height + 190, 400);
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
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
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
        .toBeLessThan(before.width * 0.8);
      const top = await grid.evaluate((el) => el.scrollTop);
      await touch("touchStart", [{ x: 290, y: 620, id: 1 }]);
      for (const nextY of [580, 530, 480, 430])
        await touch("touchMove", [{ x: 290, y: nextY, id: 1 }]);
      await touch("touchEnd", []);
      await expect
        .poll(() => grid.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(top);
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
        const fit = Math.max(
          table.width / viewport.width,
          table.height / viewport.height,
        );
        expect(fit).toBeGreaterThanOrEqual(0.99);
        expect(fit).toBeLessThanOrEqual(1.01);
      }
    });
});

test("model IDs in outputs and model legends copy to the real clipboard", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(
    page,
    "SVG",
    "cat",
    "hat",
    "direct",
    "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
    "fixture/other",
  );
  await expectProgress(page, 1, 1);
  const copy = page
    .locator(".cell")
    .getByRole("button", { name: "Copy model ID fixture/other", exact: true });
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("fixture/other");
  await expect(page.getByText("Model ID copied", { exact: true })).toHaveText(
    "Model ID copied",
  );
  const response = await page.request.post("/api/grids", {
    data: {
      format: "svg",
      prompt: "Draw a cat",
      rows: { kind: "model", values: ["fixture/text"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      harness: "direct",
    },
  });
  expect(response.status()).toBe(201);
  await page.goto(`/grid/${(await response.json()).id}`);
  await expectProgress(page, 1, 1);
  await page
    .getByRole("rowheader")
    .getByRole("button", { name: "Copy model ID fixture/text", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("fixture/text");
});

test("unsupported model efforts are explained before generation and API bypasses make no inference calls", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
  const callsBefore = await (await request.get("/fixture/calls")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("effort");
  const rows = page.getByRole("group", { name: "Row values" });
  await rows.getByRole("checkbox", { name: "None", exact: true }).check();
  await rows.getByRole("checkbox", { name: "max", exact: true }).check();
  await page
    .getByRole("group", { name: "Column values" })
    .getByRole("checkbox", { name: "Second model", exact: true })
    .check();
  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Second model (fixture/other)");
  await expect(warning).toContainText("requires thinking");
  await expect(warning).toContainText('"max"');
  await expect(warning).toContainText("low, medium, high");

  await expect(
    page.getByRole("button", { name: "Continue to prompt" }),
  ).toBeDisabled();
  const invalid = {
    format: "svg",
    prompt: "Draw a cat",
    rows: { kind: "effort", values: ["none", "max"] },
    columns: { kind: "model", values: ["fixture/other"] },
    model: "fixture/text",
    effort: "default",
    harness: "direct",
  };
  const rejected = await page.request.post("/api/grids", { data: invalid });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).issues).toHaveLength(2);
  expect(await (await request.get("/fixture/calls")).json()).toEqual(
    callsBefore,
  );
  await rows.getByRole("checkbox", { name: "None", exact: true }).uncheck();
  await rows.getByRole("checkbox", { name: "max", exact: true }).uncheck();
  await rows.getByRole("checkbox", { name: "high", exact: true }).check();
  await expect(warning).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to prompt" }).click();
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
  await page.getByRole("button", { name: "Continue to key setup" }).click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await rows.getByRole("checkbox", { name: "max", exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeDisabled();
  await rows.getByRole("checkbox", { name: "max", exact: true }).uncheck();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
});
