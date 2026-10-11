import { test, expect } from "@playwright/test";

async function expectProgress(
  page: import("@playwright/test").Page,
  finished: number,
  total: number,
) {
  const bar = page.getByRole("progressbar", { name: "Grid generation" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("value", String(finished));
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
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
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
  await expect(
    page.getByRole("button", { name: "FORK", exact: true }),
  ).toBeVisible();
  const url = page.url();
  const stranger = await page.context().browser()!.newContext();
  const publicPage = await stranger.newPage();
  await publicPage.goto(url);
  await expectProgress(publicPage, 2, 2);
  await expect(publicPage.getByText("$0.000123", { exact: true })).toHaveCount(
    2,
  );
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
      await expect(page.getByText("$0.00", { exact: true })).toHaveCount(1);
      await expect(page.getByText("$0.012345", { exact: true })).toHaveCount(1);
    } else {
      await expect(page.getByText("$0.000123", { exact: true })).toHaveCount(2);
    }
    await page.reload();
    await expectProgress(page, 2, 2);
    await expect(
      page.getByText(format === "Image" ? "$0.012345" : "$0.000123", {
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
          page
            .locator(".markdown-preview")
            .first()
            .getByRole("heading", { name: "A generated cat" }),
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

test("settings connects and disconnects OpenRouter without exposing a key to the browser", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
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
    await expect(
      page.getByText("Error 402: Insufficient credits", { exact: true }),
    ).toBeVisible();
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
      .locator(".markdown-preview")
      .first()
      .getByRole("heading", { name: "A generated cat" }),
  ).toBeVisible();
  await expect(page.getByText("$0.000246", { exact: true })).toHaveCount(2);
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
  await expect(
    page.getByRole("img", {
      name: "20 input tokens, 40 output tokens",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".cell-usage").getByText("Cost unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$0.000123", { exact: true })).toHaveCount(0);
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
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  const columns = page.getByRole("group", { name: "Column values" });
  await expect(columns.locator("label.checkbox")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  await expect(page.getByPlaceholder("Filter column models")).toBeVisible();
  const filter = page.getByLabel("Filter column models");
  const clear = page.getByRole("button", { name: "Clear column model filter" });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");
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
  const selectedModels = columns.getByRole("list", {
    name: "Selected column models",
  });
  await expect(selectedModels.getByRole("listitem")).toHaveText([
    "Fixture text",
    "Second model",
  ]);
  await selectedModels
    .getByRole("button", { name: "Remove Fixture text from columns" })
    .click();
  await expect(selectedModels.getByRole("listitem")).toHaveText([
    "Second model",
  ]);
  await expect(columns.getByText("No models match your filter.")).toBeVisible();
  await clear.click();
  await expect(filter).toHaveValue("");
  await expect(filter).toBeFocused();
  await expect(clear).toBeVisible();
  await expect(
    columns.getByRole("checkbox", { name: "Fixture text", exact: true }),
  ).not.toBeChecked();
  await expect(
    columns.getByRole("checkbox", { name: "Second model" }),
  ).toBeChecked();
  await selectedModels
    .getByRole("button", { name: "Remove Second model from columns" })
    .press("Enter");
  await expect(
    columns.getByRole("checkbox", { name: "Second model" }),
  ).not.toBeChecked();
  await expect(selectedModels).toHaveCount(0);
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
    if (kind === "model") {
      const rowFilter = page.getByLabel("Filter row models");
      const rowClear = page.getByRole("button", {
        name: "Clear row model filter",
      });
      await expect(rowClear).toBeVisible();
      await rowFilter.fill("no matching model");
      await rowClear.press("Enter");
      await expect(rowFilter).toHaveValue("");
      await expect(rowFilter).toBeFocused();
      await expect(
        page.getByRole("group", { name: "Row values" }).getByRole("checkbox"),
      ).toHaveCount(2);
      const rowModels = page.getByRole("group", { name: "Row values" });
      await rowModels
        .getByRole("checkbox", { name: "Fixture text", exact: true })
        .check();
      await rowModels
        .getByRole("button", { name: "Remove Fixture text from rows" })
        .click();
      await expect(
        rowModels.getByRole("checkbox", { name: "Fixture text", exact: true }),
      ).not.toBeChecked();
    }
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
});

test("the logo opens the grid list and its creation link starts a new grid", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await page.goto("/settings");
  await page.getByRole("link", { name: "slopgrid", exact: true }).click();
  await expect(page).toHaveURL("/grids");
  await expect(page.getByRole("heading", { name: "Your grids" })).toBeVisible();
  await expect(
    page.getByText("You haven’t created any grids yet."),
  ).toBeVisible();
  await page.getByRole("link", { name: "NEW GRID", exact: true }).click();
  await expect(page).toHaveURL("/");
  await create(page, "Image", "cat", "hat");
  await expectProgress(page, 1, 1);
  const gridURL = page.url();
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
      page
        .locator(".cell-usage")
        .getByText("Cost unavailable", { exact: true }),
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
    if (viewport.width > 700) {
      expect(
        await header
          .getByRole("link", { name: "SETTINGS", exact: true })
          .evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          ),
      ).toBeGreaterThanOrEqual(16);
    }
    async function expectActionsBesideTitle(names: string[]) {
      const title = (await header
        .getByRole("heading", { level: 1 })
        .boundingBox())!;
      for (const name of names) {
        const button = header.getByRole("button", { name, exact: true });
        const box = (await button.boundingBox())!;
        if (viewport.width > 700) {
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
    await expectActionsBesideTitle(["EDIT", "PUBLISH"]);
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
      page.getByRole("rowheader", { name: /^cat(?:\s|$)/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Generated image", exact: true })
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const cell = (await page.locator(".cell").first().boundingBox())!,
      corner = (await cornerCell.boundingBox())!;
    const rowLabel = page.getByRole("rowheader", { name: /^cat(?:\s|$)/ });
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
    await header.getByRole("button", { name: "PUBLISH" }).click();
    await expectActionsBesideTitle(["FORK", "Copy link"]);
    await expect(header.getByText("Published", { exact: true })).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "Copy link" }),
    ).toBeVisible();
    await header.getByRole("link", { name: "slopgrid", exact: true }).click();
    await page.getByRole("link", { name: "NEW GRID", exact: true }).click();
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
  await expect(page.getByText("$0.000123", { exact: true })).toBeVisible();
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
      const left = await grid.evaluate((el) => el.scrollLeft);
      await touch("touchStart", [{ x: 290, y: 620, id: 1 }]);
      for (const nextX of [250, 200, 150, 100])
        await touch("touchMove", [{ x: nextX, y: 620, id: 1 }]);
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
        .toBeLessThan(before.width * (layout === "wide grid" ? 1.01 : 0.8));
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
        harness: "direct",
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

test("model compatibility warnings allow generation and resuming unfinished cells", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.47" });
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "SVG", "cat", "hat");
  await expectProgress(page, 1, 1);
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

  await page.getByRole("button", { name: "Continue to prompt" }).click();
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
  await page.getByRole("button", { name: "Continue to key setup" }).click();
  await expect(warning).toContainText('"max"');
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    const input = {
      format: "svg",
      prompt: "Draw a cat",
      rows: { kind: "effort", values: ["none", "max"] },
      columns: { kind: "model", values: ["fixture/other"] },
      model: "fixture/text",
      effort: "default",
      harness: "direct",
    };
    const created = await page.request.post("/api/grids", { data: input });
    expect(created.status()).toBe(201);
    const grid = await created.json();
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    expect(
      (await page.request.post(`/api/grids/${grid.id}/pause`)).status(),
    ).toBe(200);
    expect(
      (await page.request.post(`/api/grids/${grid.id}/retry`)).status(),
    ).toBe(200);
    await expect
      .poll(
        async () => (await (await request.get("/fixture/calls")).json()).length,
      )
      .toBe(4);
    await request.post("/fixture/release", { data: { all: true } });
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/grids/${grid.id}`)).json())
            .status,
      )
      .toBe("complete");
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

for (const theme of ["light", "dark"] as const)
  test(`failed cells count toward progress and have red segments in ${theme} theme`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": theme === "light" ? "192.0.2.41" : "192.0.2.42",
    });
    await request.post("/fixture/reset", {
      data: { holdGenerations: true, generationError: true },
    });
    await create(page, "Image", "cat\ndog\nowl", "hat");
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    await request.post("/fixture/release", {
      data: { prompt: "Draw cat wearing a hat" },
    });
    await request.post("/fixture/release", {
      data: { prompt: "Draw dog wearing a hat" },
    });
    await expectProgress(page, 2, 3);
    const progress = page.getByRole("progressbar", { name: "Grid generation" });
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      "2 of 3 outputs finished: 1 complete, 1 failed",
    );
    await expect(page.getByRole("button", { name: "PUBLISH" })).toBeDisabled();
    const id = new URL(page.url()).pathname.split("/").pop()!;
    expect((await page.request.post(`/api/grids/${id}/publish`)).status()).toBe(
      409,
    );
    const segments = page.locator(".progress-segment");
    await expect(segments).toHaveCount(3);
    const colors = await segments.evaluateAll((elements) =>
      elements.map((el) =>
        getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number),
      ),
    );
    expect(colors[1][0]).toBeGreaterThan(colors[1][1] * 1.5);
    expect(colors[0]).not.toEqual(colors[1]);
    expect(colors[2]).not.toEqual(colors[1]);
    const width = (await segments.nth(1).boundingBox())!.width;
    expect(width).toBeCloseTo((await progress.boundingBox())!.width / 3, 0);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      "3 of 3 outputs finished: 2 complete, 1 failed",
    );
    await expect(page.getByRole("button", { name: "PUBLISH" })).toBeEnabled();
    if (theme === "light") {
      await page.getByRole("button", { name: "PUBLISH" }).click();
      await expect(
        page.getByRole("button", { name: "FORK", exact: true }),
      ).toBeVisible();
      const publicGrid = await request.get(`/api/grids/${id}`);
      expect(publicGrid.status()).toBe(200);
      expect(
        (await publicGrid.json()).cells.map(
          (cell: { status: string }) => cell.status,
        ),
      ).toEqual(["complete", "error", "complete"]);
      await page.reload();
      await expectProgress(page, 3, 3);
      await expect(
        page.locator('.progress-segment[data-status="error"]'),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "FORK", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Resume generation" }),
      ).toHaveCount(0);
      return;
    }
    await page.reload();
    await expectProgress(page, 3, 3);
    await request.post("/fixture/reset", { data: { holdGenerations: true } });
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expectProgress(page, 2, 3);
    await expect(
      page.locator('.progress-segment[data-status="error"]'),
    ).toHaveCount(0);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      "3 of 3 outputs complete",
    );
    await expect(page.getByRole("button", { name: "PUBLISH" })).toBeEnabled();
  });

test("EDIT cancels inference and restores settings, while a public FORK creates a separate grid", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.43" });
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    await create(page, "Image", "cat\ndog", "hat");
    await expect(page).toHaveURL(/\/grid\/[a-f0-9]+$/);
    const original = page.url();
    const id = new URL(original).pathname.split("/").pop()!;
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    expect((await request.post(`/api/grids/${id}/edit`)).status()).toBe(404);
    expect(
      (
        await page.request.post(`/api/grids/${id}/edit`, {
          headers: { origin: "https://attacker.invalid" },
        })
      ).status(),
    ).toBe(403);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Select grid layout" }),
    ).toBeVisible();
    await expect(page.getByLabel("Row values")).toHaveValue("cat\ndog");
    await expect(page.getByLabel("Column values")).toHaveValue("hat");
    await expect(
      page.getByRole("combobox", { name: "Model", exact: true }),
    ).toHaveValue("fixture/image");
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).aborted.length,
      )
      .toBe(2);
    const stopped = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(stopped.status).toBe("paused");
    expect(
      stopped.cells.every(
        (cell: { status: string; draft?: string }) =>
          cell.status === "pending" && !cell.draft,
      ),
    ).toBe(true);
    await request.post("/fixture/release", { data: { all: true } });
    await page.reload();
    await expect(page.getByLabel("Column values")).toHaveValue("hat");
    await page.getByLabel("Row values").fill("owl");
    await page.getByRole("button", { name: "Continue to prompt" }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
    );
    await page.getByRole("button", { name: "Continue to key setup" }).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 1, 1);
    expect(page.url()).not.toBe(original);
    await page.setViewportSize({ width: 390, height: 844 });
    const publish = page.getByRole("button", { name: "PUBLISH", exact: true });
    expect((await publish.boundingBox())!.width).toBeLessThan(160);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await expect(page.getByLabel("Row values")).toHaveValue("owl");
    await page.goBack();
    await publish.click();
    const published = page.url();
    expect(
      (
        await page.request.post(`/api/grids/${published.split("/").pop()}/edit`)
      ).status(),
    ).toBe(409);
    const stranger = await page.context().browser()!.newContext();
    try {
      const visitor = await stranger.newPage();
      await visitor.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.44" });
      await visitor.goto(published);
      await expect(
        visitor.getByRole("button", { name: "EDIT", exact: true }),
      ).toHaveCount(0);
      await visitor.getByRole("button", { name: "FORK", exact: true }).click();
      await expect(visitor.getByLabel("Row values")).toHaveValue("owl");
      await visitor.getByLabel("Row values").fill("fox");
      await visitor.getByRole("button", { name: "Continue to prompt" }).click();
      await expect(visitor.getByLabel("Prompt", { exact: true })).toHaveValue(
        "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
      );
      await visitor
        .getByRole("button", { name: "Continue to key setup" })
        .click();
      await visitor.getByRole("link", { name: "Connect OpenRouter" }).click();
      await visitor
        .getByRole("button", { name: "Generate", exact: true })
        .click();
      await expectProgress(visitor, 1, 1);
      expect(visitor.url()).not.toBe(published);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "FORK", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("rowheader", { name: /^owl(?:\s|$)/ }),
      ).toBeVisible();
    } finally {
      await stranger.close();
    }
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

for (const width of [1280, 390]) {
  test(`connection loss stays in a corner without shifting the grid at ${width}px and clears on recovery`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": width === 1280 ? "192.0.2.45" : "192.0.2.46",
    });
    await request.post("/fixture/reset", { data: { holdGenerations: true } });
    await create(page, "Image", "cat", "hat");
    await expectProgress(page, 0, 1);
    let failStream!: () => void;
    const failure = new Promise<void>((resolve) => {
      failStream = resolve;
    });
    await page.route("**/api/grids/*/events", async (route) => {
      await failure;
      await route.abort("connectionfailed");
    });
    await page.reload();
    const grid = page.getByLabel("Generated output grid");
    await expect(grid).toBeVisible();
    const before = (await grid.boundingBox())!;
    failStream();
    const status = page
      .getByRole("status")
      .filter({ hasText: "Connection lost. Reconnecting…" });
    await expect(status).toBeVisible();
    expect(await grid.boundingBox()).toEqual(before);
    const label = (await status.boundingBox())!;
    expect(label.x + label.width).toBeGreaterThan(width - 32);
    expect(label.x + label.width).toBeLessThanOrEqual(width);
    expect(label.y + label.height).toBeGreaterThan(844 - 32);
    expect(label.y + label.height).toBeLessThanOrEqual(844);
    expect(label.height).toBeLessThan(48);
    const spinner = status.locator(".spinner");
    await expect(spinner).toBeVisible();
    const rotation = await spinner.evaluate(
      (element) => getComputedStyle(element).transform,
    );
    await expect
      .poll(() =>
        spinner.evaluate((element) => getComputedStyle(element).transform),
      )
      .not.toBe(rotation);
    await page.unroute("**/api/grids/*/events");
    await expect(status).toHaveCount(0, { timeout: 10000 });
    expect(await grid.boundingBox()).toEqual(before);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 1, 1);
  });
}

for (const axis of ["Rows", "Columns"] as const) {
  test(`thinking effort ${axis.toLowerCase()} follow effort order regardless of selection sequence`, async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": axis === "Rows" ? "192.0.2.48" : "192.0.2.49",
    });
    await request.post("/fixture/reset", { data: { billing: false } });
    await create(page, "SVG", "cat", "hat");
    await expectProgress(page, 1, 1);
    await page.goto("/");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    await page
      .getByRole("combobox", { name: axis, exact: true })
      .selectOption("effort");
    const other = axis === "Rows" ? "Columns" : "Rows";
    await page
      .getByRole("combobox", { name: other, exact: true })
      .selectOption("model");
    const values = page.getByRole("group", {
      name: axis === "Rows" ? "Row values" : "Column values",
    });
    await expect(values.locator("label.checkbox")).toHaveText([
      "Model default",
      "None",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    for (const effort of ["max", "high", "low"])
      await values.getByRole("checkbox", { name: effort, exact: true }).check();
    await values.getByRole("checkbox", { name: "high", exact: true }).uncheck();
    await values.getByRole("checkbox", { name: "high", exact: true }).check();
    await page
      .getByRole("group", {
        name: other === "Rows" ? "Row values" : "Column values",
      })
      .getByRole("checkbox", { name: "Fixture text", exact: true })
      .check();
    await page.getByRole("button", { name: "Continue to prompt" }).click();
    await page.getByLabel("Prompt", { exact: true }).fill("Draw a cat");
    await page.getByRole("button", { name: "Continue to key setup" }).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 3, 3);
    const labels =
      axis === "Rows"
        ? page.getByRole("rowheader")
        : page.getByRole("columnheader").filter({ hasText: /\S/ });
    await expect(labels).toHaveText(["low", "high", "max"]);
    await page.reload();
    await expect(labels).toHaveText(["low", "high", "max"]);
  });
}

test("a grid with only failed outputs can be published and viewed publicly", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.50" });
  await request.post("/fixture/reset", { data: { generationError: true } });
  await create(page, "Image", "dog", "hat");
  await expectProgress(page, 1, 1);
  await expect(
    page.locator('.progress-segment[data-status="error"]'),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "PUBLISH", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "FORK", exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const result = await request.get(`/api/grids/${id}`);
  expect(result.status()).toBe(200);
  const grid = await result.json();
  expect(grid.published).toBe(true);
  expect(grid.cells[0].status).toBe("error");
  expect(grid.cells[0].errorCode).toBe(500);
  expect(grid.cells[0].error).toBe("Fixture generation failed");
  await expect(
    page.getByText("Error 500: Fixture generation failed", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Error 500: Fixture generation failed", { exact: true }),
  ).toBeVisible();
  expect(grid.cells[0].outputURL).toBeUndefined();
});

test("live updates close when generation settles and reopen after Resume, including paused grids with active requests", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.51" });
  const streams = new Set<import("@playwright/test").Request>();
  let opened = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/events")) {
      streams.add(request);
      opened++;
    }
  });
  page.on("requestfailed", (request) => streams.delete(request));
  page.on("requestfinished", (request) => streams.delete(request));
  await request.post("/fixture/reset", {
    data: { holdGenerations: true, billing: true },
  });
  try {
    await create(page, "Image", "cat\ndog\nowl", "hat");
    await expect.poll(() => streams.size).toBe(1);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    await request.post("/fixture/release", {
      data: { prompt: "Draw dog wearing a hat" },
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Resume generation" }),
    ).toBeVisible();
    expect(streams.size).toBe(1);
    await request.post("/fixture/release", {
      data: { prompt: "Draw cat wearing a hat" },
    });
    await expectProgress(page, 1, 3);
    await expect.poll(() => streams.size).toBe(0);
    await request.post("/fixture/credits");
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect.poll(() => streams.size).toBe(1);
    await expect.poll(() => opened).toBe(2);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    await page.getByRole("button", { name: "Pause generation" }).click();
    await expect.poll(() => streams.size).toBe(0);
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect.poll(() => streams.size).toBe(1);
    await expect.poll(() => opened).toBe(3);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
    await expect.poll(() => streams.size).toBe(0);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "FORK", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expectProgress(page, 3, 3);
    expect(streams.size).toBe(0);
    expect(opened).toBe(3);
    const status = page
      .getByRole("status")
      .filter({ hasText: "Connection lost. Reconnecting…" });
    await page.context().setOffline(true);
    await expect(status).toHaveCount(0);
    expect(streams.size).toBe(0);
    await page.context().setOffline(false);
  } finally {
    await page.context().setOffline(false);
    await request.post("/fixture/release", { data: { all: true } });
  }
});

for (const [index, mode] of [
  { format: "Image", code: 429, stream: false },
  { format: "SVG", code: 402, stream: false },
  { format: "SVG", code: 402, stream: true },
  { format: "Markdown", code: 429, stream: true },
].entries()) {
  test(`${mode.format} automatically retries temporary ${mode.code} limits${mode.stream ? " during streaming" : ""} and preserves successful cells`, async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": `192.0.2.${52 + index}`,
    });
    await request.post("/fixture/reset", {
      data: {
        transientFailures: 1,
        transientStatus: mode.code,
        transientStream: mode.stream,
      },
    });
    await create(page, mode.format, "cat\ndog", "hat");
    await expect(
      page.getByText("Waiting to retry…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Error ${mode.code}: Temporary provider limit`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Pause generation" }),
    ).toBeVisible();
    await expectProgress(page, 2, 2);
    await expect(
      page.getByText("Waiting to retry…", { exact: true }),
    ).toHaveCount(0);
    const calls: string[] = await (await request.get("/fixture/calls")).json();
    expect(calls.filter((prompt) => prompt.includes("cat"))).toHaveLength(1);
    expect(calls.filter((prompt) => prompt.includes("dog"))).toHaveLength(2);
  });
}

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
