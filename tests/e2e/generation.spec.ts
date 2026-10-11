import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

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
  await finishPublishing(page);
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

test("parallel generation queues users and gives freed slots to users with fewer workers", async ({
  page,
  request,
  baseURL,
}) => {
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  const browser = page.context().browser()!;
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
    await finishPublishing(page);
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
    expect(
      (
        await page.request.post(`/api/grids/${id}/publish`, {
          data: { visibility: "unlisted" },
        })
      ).status(),
    ).toBe(409);
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
      await finishPublishing(page);
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
  await finishPublishing(page);
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
    await finishPublishing(page);
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
        holdGenerations: true,
        transientFailures: 1,
        transientStatus: mode.code,
        transientStream: mode.stream,
      },
    });
    await create(page, mode.format, "cat\ndog", "hat");
    await expectProgress(page, 0, 2);
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    const { held }: { held: string[] } = await (
      await request.get("/fixture/workers")
    ).json();
    for (const prompt of held)
      await request.post("/fixture/release", { data: { prompt } });
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
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 2, 2);
    await expect(
      page.getByText("Waiting to retry…", { exact: true }),
    ).toHaveCount(0);
    const calls: string[] = await (await request.get("/fixture/calls")).json();
    expect(calls.filter((prompt) => prompt.includes("cat"))).toHaveLength(1);
    expect(calls.filter((prompt) => prompt.includes("dog"))).toHaveLength(2);
  });
}

test("website bundles preview HTML, CSS, and JavaScript before completion and restart after Pause", async ({
  page,
  request,
}) => {
  await page.route("**/api/grids", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "X-Forwarded-For": "192.0.2.60",
      },
    }),
  );
  await request.post("/fixture/reset", { data: { websiteStreaming: true } });
  await create(page, "Static website", "cat", "hat");
  const frame = page.frameLocator("iframe").first();
  const iframe = page.locator("iframe").first();
  await expect(
    frame.getByRole("heading", { name: "Growing website" }),
  ).toBeVisible();
  await expectProgress(page, 0, 1);
  const original = (await iframe.getAttribute("src"))!;
  await request.post("/fixture/website-next");
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 0, 0)",
  );
  await request.post("/fixture/website-next");
  await expect(frame.getByText("Streaming module loaded")).toBeVisible();
  await expectProgress(page, 0, 1);
  await page.getByRole("button", { name: "Pause generation" }).click();
  await expect(iframe).toHaveCount(0);
  expect((await page.request.get(original)).status()).toBe(404);
  await page.getByRole("button", { name: "Resume generation" }).click();
  await expect(
    frame.getByRole("heading", { name: "Growing website" }),
  ).toBeVisible();
  expect(await iframe.getAttribute("src")).not.toBe(original);
  await request.post("/fixture/website-next");
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 0, 0)",
  );
  await request.post("/fixture/website-next");
  await expect(frame.getByText("Streaming module loaded")).toBeVisible();
  await request.post("/fixture/website-next");
  await expectProgress(page, 1, 1);
  await expect(
    frame.getByRole("heading", { name: "Growing website" }),
  ).toBeVisible();
  await expect(frame.getByText("Streaming module loaded")).toBeVisible();
  expect(await iframe.getAttribute("src")).not.toContain("__preview");
  expect((await page.request.get(original)).status()).toBe(404);
});

test("OpenRouter balance sets parallel capacity and Resume refreshes it after a top-up", async ({
  page,
  request,
}) => {
  await page.route("**/api/grids", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "X-Forwarded-For": "192.0.2.61",
      },
    }),
  );
  await request.post("/fixture/reset", {
    data: { balanceUsd: 5.99, holdGenerations: true },
  });
  const calls = async (): Promise<string[]> =>
    (await request.get("/fixture/calls")).json();
  try {
    await create(page, "Image", "cat\ndog\nowl", "hat");
    await expect(page.getByText("Generating…", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Queued", { exact: true })).toHaveCount(2);
    expect(await calls()).toHaveLength(1);
    await request.post("/fixture/release", {
      data: { prompt: (await calls())[0] },
    });
    await expectProgress(page, 1, 3);
    await expect.poll(async () => (await calls()).length).toBe(2);
    await expect(page.getByText("Generating…", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Pause generation" }).click();
    await request.post("/fixture/credits", { data: { balanceUsd: 6 } });
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect(page.getByText("Generating…", { exact: true })).toHaveCount(2);
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});
