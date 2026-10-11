import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

test("drafts, mutation endpoints, and generated hosts enforce ownership and origin boundaries", async ({
  page,
  request,
  baseURL,
}) => {
  await request.post("/fixture/reset", { data: { billing: false } });
  await create(page, "Static website");
  await expectProgress(page, 2, 2);
  const id = page.url().split("/").pop();
  const anonymous = await (
    await import("@playwright/test")
  ).request.newContext({ baseURL });
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
  const isolated = new URL(
    page
      .frames()
      .find((frame) => frame !== page.mainFrame())!
      .url(),
  );
  expect(isolated.hostname).toMatch(/^[a-f0-9]{48}-slopgrid\.localhost$/);
  const response = await page.request.get(output!);
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(response.headers()["content-security-policy"]).toContain("sandbox");
  expect(
    (
      await request.get(`${baseURL}/api/session`, {
        headers: { host: isolated.host },
      })
    ).status(),
  ).toBe(404);
  const cellId = isolated.hostname.split("-")[0];
  for (const url of [
    output!,
    isolated.href,
    new URL("style.css", isolated).href,
    new URL("app.js", isolated).href,
    `/outputs/${cellId}/download`,
  ])
    expect((await anonymous.get(url)).status(), url).toBe(404);
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
  const attacker = await page.context().newPage();
  const asset = new URL("app.js", isolated).href;
  await attacker.route("http://attacker.localhost/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>onmessage = event => document.body.dataset.result = event.data</script><iframe sandbox="allow-scripts" srcdoc='${`<script>fetch(${JSON.stringify(asset)}, {credentials:"include"}).then(response => response.text()).then(() => parent.postMessage("leaked", "*"), () => parent.postMessage("blocked", "*"))</script>`.replaceAll("'", "&#39;")}'></iframe>`,
    }),
  );
  await attacker.goto("http://attacker.localhost/");
  await expect(attacker.locator("body")).toHaveAttribute(
    "data-result",
    "blocked",
  );
  await attacker.close();
  // An already issued output cookie stops authorizing files after session rotation.
  await page.request.post("/api/auth/logout");
  expect((await page.request.get(isolated.href)).status()).toBe(404);
  // Reopening through the app reauthorizes this still-owned anonymous grid.
  await page.reload();
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  expect((await anonymous.get(output!)).status()).toBe(200);
  expect((await anonymous.get(isolated.href)).status()).toBe(200);
  expect((await anonymous.get(asset)).status()).toBe(200);
  expect((await anonymous.get(`/outputs/${cellId}/download`)).status()).toBe(
    200,
  );
  await anonymous.dispose();
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
  expect(session).toEqual({ connected: true, user: null });
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
    user: null,
  });
});

for (const format of ["SVG", "Markdown"])
  test(`${format} on the app host cannot execute generated scripts or access cookies`, async ({
    page,
    request,
    baseURL,
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
    expect(new URL(output).origin).toBe(baseURL);
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
      name: "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
    })
    .click();
  await expect(page).toHaveURL(gridURL);
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
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
    );
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
    await finishPublishing(page);
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
      await expect(visitor.getByLabel("Prompt", { exact: true })).toHaveValue(
        "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN",
      );
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

test("publishing dialogs preserve private grids, handle failures, and remember successful confirmation", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.51" });
  await request.post("/fixture/reset", { data: {} });
  await create(page, "SVG", "cat");
  await expectProgress(page, 1, 1);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const publish = page.getByRole("button", { name: "PUBLISH", exact: true });
  const dialog = page.getByRole("dialog");
  await publish.click();
  await expect(dialog).toHaveAccessibleName("Control who can see this grid");
  await expect(
    dialog.getByRole("radio", { name: "Keep private" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "Keep private" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(publish).toBeFocused();
  await publish.click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(
    (await (await page.request.get(`/api/grids/${id}`)).json()).published,
  ).toBe(false);
  await publish.click();
  await dialog.getByRole("radio", { name: "Accessible by link" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Confirm publishing");
  await expect(
    dialog.getByText(
      "This projects aims to facilitate model benchmarking and research, and we don't want valuable data to disappear. For this reason, making a published grid private is impossible.",
    ),
  ).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Don’t ask again" }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "Accessible by link" }),
  ).toBeChecked();
  expect(
    (await (await page.request.get(`/api/grids/${id}`)).json()).published,
  ).toBe(false);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.route(`**/api/grids/${id}/publish`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Publishing failed" }),
    }),
  );
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Publishing failed");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("slopgrid-skip-publish-confirmation"),
    ),
  ).toBeNull();
  await page.unroute(`**/api/grids/${id}/publish`);
  let release!: () => void;
  await page.route(`**/api/grids/${id}/publish`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("slopgrid-skip-publish-confirmation"),
    ),
  ).toBe("true");
  await expect(publish).toHaveCount(0);
  const first = await (await page.request.get(`/api/grids/${id}`)).json();
  const next = await (
    await page.request.post("/api/grids", {
      headers: { "X-Forwarded-For": "192.0.2.51" },
      data: first.input,
    })
  ).json();
  await page.goto(`/grid/${next.id}`);
  await expectProgress(page, 1, 1);
  await page.reload();
  await publish.click();
  await dialog.getByRole("radio", { name: "Listed publicly" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/grids/${next.id}`)).json()).visibility,
  ).toBe("public");
});

test("owners can list a link-only published grid publicly without regenerating outputs", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.60" });
  await request.post("/fixture/reset", { data: {} });
  const prompt = "Promoted grid $VARIABLE_ROW $VARIABLE_COLUMN";
  await create(page, "SVG", "cat", "hat", prompt);
  await expectProgress(page, 1, 1);
  const url = page.url();
  const id = new URL(url).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  const before = await (await page.request.get(`/api/grids/${id}`)).json();
  const calls = await (await request.get("/fixture/calls")).json();
  await page.reload();
  const visibility = page.getByRole("button", { name: "Change visibility" });
  await visibility.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("radio", { name: "Accessible by link" }),
  ).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Keep private" })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(visibility).toBeFocused();
  const visitorContext = await page.context().browser()!.newContext();
  const visitor = await visitorContext.newPage();
  try {
    await visitor.goto(url);
    await expect(
      visitor.getByRole("button", { name: "Change visibility" }),
    ).toHaveCount(0);
    expect(
      (
        await visitor.request.post(`/api/grids/${id}/publish`, {
          data: { visibility: "public" },
        })
      ).status(),
    ).toBe(404);
    await visitor.goto("/grids");
    const publicGrids = visitor.getByRole("region", {
      name: "Public grids",
      exact: true,
    });
    await expect(
      publicGrids.getByRole("link", { name: new RegExp("Promoted grid") }),
    ).toHaveCount(0);
    await visibility.click();
    await dialog.getByRole("radio", { name: "Listed publicly" }).check();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(visibility).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    expect(page.url()).toBe(url);
    await page.reload();
    const after = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(after.visibility).toBe("public");
    expect(after.cells).toEqual(before.cells);
    expect(after.input).toEqual(before.input);
    expect(await (await request.get("/fixture/calls")).json()).toEqual(calls);
    await visitor.reload();
    await expect(
      publicGrids.getByRole("link", { name: new RegExp("Promoted grid") }),
    ).toBeVisible();
    await page.goto("/grids");
    await expect(
      page
        .getByRole("region", { name: "Public grids", exact: true })
        .getByRole("link", { name: new RegExp("Promoted grid") }),
    ).toBeVisible();
  } finally {
    await visitorContext.close();
  }
});

test("both grid listings show format icons with Tippy tooltips and public grids are visible to visitors", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.52" });
  await request.post("/fixture/reset", { data: {} });
  await create(
    page,
    "SVG",
    "cat",
    "hat",
    "Public SVG $VARIABLE_ROW $VARIABLE_COLUMN",
  );
  await expectProgress(page, 1, 1);
  const firstId = new URL(page.url()).pathname.split("/").pop()!;
  const first = await (await page.request.get(`/api/grids/${firstId}`)).json();
  const ids = [firstId];
  for (const format of ["markdown", "html", "image"]) {
    const result = await page.request.post("/api/grids", {
      headers: { "X-Forwarded-For": "192.0.2.52" },
      data: {
        ...first.input,
        format,
        model: format === "image" ? "fixture/image" : first.input.model,
        prompt: `Public ${format} $VARIABLE_ROW $VARIABLE_COLUMN`,
      },
    });
    expect(result.status()).toBe(201);
    const grid = await result.json();
    ids.push(grid.id);
    await page.goto(`/grid/${grid.id}`);
    await expectProgress(page, 1, 1);
  }
  for (const id of ids) {
    expect(
      (
        await page.request.post(`/api/grids/${id}/publish`, {
          data: { visibility: "public" },
        })
      ).status(),
    ).toBe(200);
  }
  const unlisted = await (
    await page.request.post("/api/grids", {
      headers: { "X-Forwarded-For": "192.0.2.52" },
      data: {
        ...first.input,
        prompt: "Unlisted $VARIABLE_ROW $VARIABLE_COLUMN",
      },
    })
  ).json();
  await page.goto(`/grid/${unlisted.id}`);
  await expectProgress(page, 1, 1);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.goto("/grids");
  const mine = page.getByRole("region", { name: "Your grids", exact: true });
  const publiclyListed = page.getByRole("region", {
    name: "Public grids",
    exact: true,
  });
  await expect(
    publiclyListed.getByText("See what others have created"),
  ).toBeVisible();
  await expect(mine.getByRole("link", { name: /Unlisted/ })).toBeVisible();
  await expect(
    publiclyListed.getByRole("link", { name: /Unlisted/ }),
  ).toHaveCount(0);
  for (const listing of [mine, publiclyListed]) {
    for (const type of ["SVG", "Markdown", "Static website", "Image"]) {
      const icon = listing
        .getByRole("img", { name: type, exact: true })
        .first();
      await icon.hover();
      await expect(
        page.locator('.tippy-box[data-state="visible"]'),
      ).toHaveCount(1);
      await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
        type,
      );
      await page.mouse.move(0, 0);
      await expect(
        page.locator('.tippy-box[data-state="visible"]'),
      ).toHaveCount(0);
      await icon.focus();
      await expect(
        page.locator('.tippy-box[data-state="visible"]'),
      ).toHaveCount(1);
      await expect(page.locator('.tippy-box[data-state="visible"]')).toHaveText(
        type,
      );
      await icon.evaluate((element) => (element as HTMLElement).blur());
      await expect(
        page.locator('.tippy-box[data-state="visible"]'),
      ).toHaveCount(0);
    }
  }
  const visitor = await page.context().browser()!.newContext();
  try {
    const other = await visitor.newPage();
    await other.goto("/grids");
    await expect(
      other
        .getByRole("region", { name: "Your grids", exact: true })
        .locator(".history")
        .getByRole("link"),
    ).toHaveCount(0);
    await expect(
      other
        .getByRole("region", { name: "Public grids", exact: true })
        .getByRole("link", { name: /Public SVG/ }),
    ).toBeVisible();
    await other.goto(`/grid/${firstId}`);
    await expectProgress(other, 1, 1);
    await other.getByRole("button", { name: "FORK", exact: true }).click();
    await expect(other.getByLabel("Row values")).toHaveValue("cat");
  } finally {
    await visitor.close();
  }
});

test("publishing still works when browser storage is unavailable and asks again", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.53" });
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "slopgrid-skip-publish-confirmation")
        throw new Error("Storage unavailable");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "slopgrid-skip-publish-confirmation")
        throw new Error("Storage unavailable");
      set.call(this, key, value);
    };
  });
  await request.post("/fixture/reset", { data: {} });
  await create(page, "SVG", "cat");
  await expectProgress(page, 1, 1);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const initial = await (await page.request.get(`/api/grids/${id}`)).json();
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Accessible by link" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Don’t ask again" }).check();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "FORK", exact: true }),
  ).toBeVisible();
  const next = await (
    await page.request.post("/api/grids", {
      headers: { "X-Forwarded-For": "192.0.2.53" },
      data: initial.input,
    })
  ).json();
  await page.goto(`/grid/${next.id}`);
  await expectProgress(page, 1, 1);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
});
test("manual key entry persists in the browser, rejects invalid replacements, and supplies Generate and Resume", async ({
  page,
  request,
}) => {
  await page.route("**/api/grids", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "X-Forwarded-For": "192.0.2.63",
      },
    }),
  );
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  try {
    await page.goto("/settings");
    const otherTab = await page.context().newPage();
    await otherTab.goto("/settings");
    await page.getByRole("button", { name: "Use API key" }).click();
    await page
      .getByLabel("API key", { exact: true })
      .fill("fixture-manual-key");
    await page.getByRole("button", { name: "Connect API key" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    expect(await (await page.request.get("/api/session")).json()).toEqual({
      connected: false,
      user: null,
    });
    await expect(
      otherTab.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use API key" }).click();
    await page.getByLabel("API key", { exact: true }).fill("invalid-key");
    await page.getByRole("button", { name: "Connect API key" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Invalid OpenRouter API key.",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.goto("/");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await page.getByLabel("Row values").fill("cat");
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("variable");
    await page.getByLabel("Column values").fill("hat");
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("fixture/text");
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Draw $VARIABLE_ROW with $VARIABLE_COLUMN");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expectProgress(page, 0, 1);
    await page.getByRole("button", { name: "Pause generation" }).click();
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect(page.locator(".markdown-preview")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 1, 1);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Disconnect OpenRouter" }).click();
    await expect(
      otherTab.getByText("Not connected", { exact: true }),
    ).toBeVisible();
    await otherTab.close();
    await expect(
      page.getByText("Not connected", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Not connected", { exact: true }),
    ).toBeVisible();
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("titles are independent owner-editable metadata and collapsed prompts expand and copy in full", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.64" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  const prompt =
    "Draw $VARIABLE_ROW wearing a $VARIABLE_COLUMN.\n" +
    "Preserve all of these details, including punctuation & <plain text>. "
      .repeat(12)
      .trim();
  const visitor = await context.browser()!.newContext({ baseURL });
  try {
    await create(page, "Image", "cat", "hat", prompt);
    await expectProgress(page, 0, 1);
    const id = page.url().split("/").pop();
    const endpoint = `/api/grids/${id}/title`;
    const header = page.getByRole("banner");
    const heading = header.getByRole("heading", { level: 1 });
    const titleField = page.getByRole("textbox", { name: "Grid title" });
    await header
      .getByRole("button", { name: "Set Title", exact: true })
      .click();
    await expect(titleField).toHaveValue("");
    await titleField.fill("Discard this title");
    await titleField.press("Escape");
    await expect(
      header.getByRole("button", { name: "Set Title", exact: true }),
    ).toBeVisible();
    await header
      .getByRole("button", { name: "Set Title", exact: true })
      .click();
    await titleField.fill("  Flight study  ");
    await titleField.press("Enter");
    await expect(
      header.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Flight study");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await heading.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await heading.hover();
      const tooltip = page.locator(
        '[data-theme="grid-prompt"][data-state="visible"]',
      );
      await expect(tooltip).toHaveText(prompt);
      const bounds = (await tooltip.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
    }
    await header
      .getByRole("button", { name: "Copy prompt", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(prompt);
    expect(
      (
        await visitor.request.patch(endpoint, {
          data: { title: "Someone else's title" },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.patch(endpoint, {
          headers: { origin: "https://evil.example" },
          data: { title: "Cross-origin title" },
        })
      ).status(),
    ).toBe(403);
    for (const data of [{}, { title: null }, { title: "x".repeat(201) }])
      expect((await page.request.patch(endpoint, { data })).status()).toBe(400);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 1, 1);
    await page.reload();
    await expect(
      header.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Flight study");
    await expect(heading).toHaveText(prompt);
    const snapshot = await (await page.request.get(`/api/grids/${id}`)).json();
    expect(snapshot.cells[0].prompt).toBe(
      prompt
        .replaceAll("$VARIABLE_ROW", "cat")
        .replaceAll("$VARIABLE_COLUMN", "hat"),
    );
    expect(await (await request.get("/fixture/calls")).json()).toHaveLength(1);
    expect(
      (
        await page.request.post(`/api/grids/${id}/publish`, {
          data: { visibility: "public" },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await header
      .getByRole("button", { name: "Edit title", exact: true })
      .click();
    await titleField.fill("Published flight study");
    await heading.click();
    await expect(
      header.getByRole("button", { name: "Edit title", exact: true }),
    ).toHaveText("Published flight study");
    const publicPage = await visitor.newPage();
    await publicPage.goto(`/grid/${id}`);
    await expect(publicPage.locator(".grid-name")).toHaveText(
      "Published flight study",
    );
    await expect(
      publicPage.getByRole("button", { name: /Set Title|Edit title/ }),
    ).toHaveCount(0);
    expect(
      (
        await visitor.request.patch(endpoint, {
          data: { title: "Unauthorized rename" },
        })
      ).status(),
    ).toBe(404);
    await publicPage.goto("/grids");
    await expect(
      publicPage.getByRole("link", {
        name: "Published flight study",
      }),
    ).toBeVisible();
    await header
      .getByRole("button", { name: "Edit title", exact: true })
      .click();
    await titleField.fill("   ");
    await titleField.press("Enter");
    await expect(
      header.getByRole("button", { name: "Set Title", exact: true }),
    ).toBeVisible();
    await publicPage.goto(`/grid/${id}`);
    await expect(publicPage.locator(".grid-name, .grid-title-dot")).toHaveCount(
      0,
    );
    await expect(publicPage.getByRole("heading", { level: 1 })).toHaveText(
      prompt,
    );
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await expect(
      page.locator(".history-prompt").filter({ hasText: prompt }),
    ).toHaveCount(2);
    const short = await page.request.post("/api/grids", {
      data: { ...snapshot.input, prompt: "$VARIABLE_ROW $VARIABLE_COLUMN" },
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/grid/${(await short.json()).id}`);
    await expectProgress(page, 1, 1);
    expect(
      await heading.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await heading.hover();
    await expect(
      page.locator('[data-theme="grid-prompt"][data-state="visible"]'),
    ).toHaveCount(0);
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
    await visitor.close();
  }
});
