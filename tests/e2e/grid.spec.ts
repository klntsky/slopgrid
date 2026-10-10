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

for (const format of ["SVG", "Markdown", "index.html", "Image"])
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
    if (format === "index.html")
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
      if (format === "index.html") {
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
  await create(page, "index.html");
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
  await create(page, "index.html", "cat\ndog\nowl", "hat\ncape\nscarf\ncrown");
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
