import { test, expect } from "@playwright/test";

async function create(
  page: import("@playwright/test").Page,
  format = "SVG",
  rows = "cat\ndog",
  columns = "hat",
  harness = "direct",
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
  if (format !== "Image")
    await page
      .getByRole("combobox", { name: "Harness", exact: true })
      .selectOption(harness);
  await page.getByRole("button", { name: "Continue to prompt" }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN");
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
  await expect(page.getByText("1 of 2 complete")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry unfinished cells", exact: true })
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
  await expect(page.getByText("2 of 2 complete")).toBeVisible();
  await page.getByRole("button", { name: "Publish grid" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const url = page.url();
  const stranger = await page.context().browser()!.newContext();
  const publicPage = await stranger.newPage();
  await publicPage.goto(url);
  await expect(publicPage.getByText("2 of 2 complete")).toBeVisible();
  await expect(
    publicPage.getByRole("button", { name: "Publish grid" }),
  ).toHaveCount(0);
  await stranger.close();
  const calls = await (await request.get("/fixture/calls")).json();
  expect(calls.filter((p: string) => p.includes("cat")).length).toBe(1);
  expect(calls.filter((p: string) => p.includes("dog")).length).toBe(3);
});

for (const format of ["SVG", "Markdown", "Static website", "Image"])
  test(`${format} renders generated output`, async ({ page, request }) => {
    await request.post("/fixture/reset", { data: { billing: false } });
    await create(page, format);
    await expect(page.getByText("2 of 2 complete")).toBeVisible();
    const output = new URL(
      (await page
        .getByRole("link", { name: "Open output ↗" })
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
    if (format === "Image") {
      const image = page.getByRole("img", { name: "Generated image" }).first();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      const response = await request.get(output.href);
      expect(response.headers()["content-type"]).toContain("image/png");
      expect(response.headers()["set-cookie"]).toBeUndefined();
      await expect(page.locator("iframe")).toHaveCount(0);
    } else {
      const frame = page.frameLocator("iframe").first();
      if (format === "SVG") await expect(frame.locator("svg")).toBeVisible();
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
  await expect(page.getByText("2 of 2 complete")).toBeVisible();
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
  await create(page, "Static website", "cat\ndog\nowl", "hat\ncape\nscarf\ncrown");
  await expect(page.getByText("12 of 12 complete")).toBeVisible();
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
    await expect(page.getByText("1 of 2 complete")).toBeVisible();
    await request.post("/fixture/credits");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retry unfinished cells" })
      .click();
    await expect(page.getByText("2 of 2 complete")).toBeVisible();
    const calls = await (await request.get("/fixture/calls")).json();
    expect(calls.filter((p: string) => p.includes("cat"))).toHaveLength(1);
  });

test("draft and review makes a second request for each cell and renders the final output", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Markdown", "cat\ndog", "hat", "review");
  await expect(page.getByText("2 of 2 complete")).toBeVisible();
  await expect(
    page
      .frameLocator("iframe")
      .first()
      .getByRole("heading", { name: "A generated cat" }),
  ).toBeVisible();
  const calls = await (await request.get("/fixture/calls")).json();
  expect(calls).toHaveLength(4);
  expect(
    calls.filter((p: string) => p.includes("Check the draft")),
  ).toHaveLength(2);
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
    await expect(page.getByText("2 of 2 complete")).toBeVisible();
    const output = (await page
      .getByRole("link", { name: "Open output ↗" })
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
  await expect(page.getByText("4 of 4 complete")).toBeVisible();
  await expect(page.getByText("Image GRID", { exact: true })).toHaveCount(0);
});
