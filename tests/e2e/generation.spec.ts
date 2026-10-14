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
for (const action of ["publish", "resume"] as const)
  test(`failed cells count toward progress and allow ${action} after settlement`, async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": action === "publish" ? "192.0.2.41" : "192.0.2.42",
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
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 3, 3);
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      "3 of 3 outputs finished: 2 complete, 1 failed",
    );
    await expect(page.getByRole("button", { name: "PUBLISH" })).toBeEnabled();
    if (action === "publish") {
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

test("a dropped event stream reconnects and receives completed generation", async ({
  page,
  request,
}) => {
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
  failStream();
  const status = page
    .getByRole("status")
    .filter({ hasText: "Connection lost. Reconnecting…" });
  await expect(status).toBeVisible();
  await page.unroute("**/api/grids/*/events");
  await expect(status).toHaveCount(0, { timeout: 10000 });
  await request.post("/fixture/release", { data: { all: true } });
  await expectProgress(page, 1, 1);
});

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

for (const model of ["fixture/text", "fixture/other"])
  test(`website bundles (${model}) swap streamed HTML, CSS, and JavaScript without losing scroll, and restart after Pause`, async ({
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
    await create(
      page,
      "Static website",
      "cat",
      "hat",
      "Draw $ROW wearing a $COLUMN",
      model,
    );
    const frame = page.frameLocator("iframe:visible").first();
    const iframe = page.locator("iframe:visible").first();
    const scrollTo = (position: number[]) =>
      frame.locator("body").evaluate((_, [left, top, panelLeft, panelTop]) => {
        window.scrollTo({ left, top, behavior: "instant" });
        document
          .getElementById("scroll-panel")!
          .scrollTo({ left: panelLeft, top: panelTop, behavior: "instant" });
      }, position);
    const scrollPosition = () =>
      frame.locator("body").evaluate(() => {
        const panel = document.getElementById("scroll-panel")!;
        return [scrollX, scrollY, panel.scrollLeft, panel.scrollTop];
      });
    await expect(
      frame.getByRole("heading", { name: "Growing website" }),
    ).toBeVisible();
    await expectProgress(page, 0, 1);
    const original = (await iframe.getAttribute("src"))!;
    const originalFrame = (await iframe.elementHandle())!;
    await page.getByRole("button", { name: "Show thinking" }).click();
    await expect(
      page.getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Planning the website layout.");
    await page.getByRole("button", { name: "Expand thinking" }).click();
    await page.getByRole("button", { name: "Collapse thinking" }).click();
    await page.getByRole("button", { name: "Show output" }).click();
    expect(await originalFrame.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    let previewBlocked = false;
    await page.route(
      "**/__preview/**/index.html",
      async (route) => {
        previewBlocked = true;
        await previewGate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await request.post("/fixture/website-next");
      await expect.poll(() => previewBlocked).toBe(true);
      // The hidden frame has already loaded its authorization bootstrap here.
      // The old document must remain visible until the generated HTML loads too.
      await expect(page.locator("iframe")).toHaveCount(2);
      expect(await originalFrame.isVisible()).toBe(true);
      await expect(iframe).toHaveAttribute("src", original);
      await expect(
        frame.getByRole("heading", { name: "Growing website" }),
      ).toBeVisible();
      await scrollTo([140, 640, 60, 180]);
      await request.post("/fixture/website-next");
    } finally {
      releasePreview();
    }
    await expect(frame.getByText("Streaming module loaded")).toBeVisible();
    await expect
      .poll(() => originalFrame.evaluate((element) => element.isConnected))
      .toBe(false);
    await expect.poll(scrollPosition).toEqual([140, 640, 60, 180]);
    // A request sent by the generated document itself must not control the bridge.
    await frame.locator("body").evaluate(
      () =>
        new Promise<void>((resolve) => {
          const { port1, port2 } = new MessageChannel();
          addEventListener(
            "message",
            () => {
              port1.close();
              resolve();
            },
            { once: true },
          );
          window.postMessage(
            { type: "slopgrid:scroll", positions: [["", 0, 0]] },
            "*",
            [port2],
          );
        }),
    );
    expect(await scrollPosition()).toEqual([140, 640, 60, 180]);
    await expectProgress(page, 0, 1);
    await page.getByRole("button", { name: "Pause generation" }).click();
    await expect(iframe).toHaveCount(0);
    expect((await page.request.get(original)).status()).toBe(404);
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect(
      frame.getByRole("heading", { name: "Growing website" }),
    ).toBeVisible();
    expect(await iframe.getAttribute("src")).not.toBe(original);
    const expand = page.getByRole("button", {
      name: "Expand Static website",
      exact: true,
    });
    await expect(expand).toBeVisible();
    await expand.click();
    const expanded = page.getByRole("region", { name: /^Expanded output:/ });
    await expect(
      expanded.frameLocator("iframe:visible").getByRole("heading", {
        name: "Growing website",
      }),
    ).toBeVisible();
    await request.post("/fixture/website-next");
    await request.post("/fixture/website-next");
    await expect(
      expanded
        .frameLocator("iframe:visible")
        .getByText("Streaming module loaded"),
    ).toBeVisible();
    await expanded
      .getByRole("button", { name: "Collapse Static website", exact: true })
      .click();
    await expect(expanded).toHaveCount(0);
    await expect(expand).toBeFocused();
    await expect(frame.getByText("Streaming module loaded")).toBeVisible();
    let releaseSaved!: () => void;
    const savedGate = new Promise<void>((resolve) => {
      releaseSaved = resolve;
    });
    let savedBlocked = false;
    await page.route(
      (url) => url.pathname === "/index.html",
      async (route) => {
        savedBlocked = true;
        await savedGate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await request.post("/fixture/website-next");
      await expect.poll(() => savedBlocked).toBe(true);
      await expectProgress(page, 1, 1);
      await expect(iframe).toHaveAttribute("src", /__preview/);
      await expect(frame.getByText("Streaming module loaded")).toBeVisible();
      await scrollTo([200, 900, 90, 220]);
    } finally {
      releaseSaved();
    }
    await expect(iframe).not.toHaveAttribute("src", /__preview/);
    await expect(frame.getByText("Streaming module loaded")).toBeVisible();
    await expect.poll(scrollPosition).toEqual([200, 900, 90, 220]);
    expect((await page.request.get(original)).status()).toBe(404);
  });

test("OpenRouter balance sets automatic parallel capacity and Resume recalculates unfinished work", async ({
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
    await create(page, "SVG", "cat\ndog\nowl", "hat");
    await expect(page.getByText("Generating…", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Queued", { exact: true })).toHaveCount(2);
    await expect.poll(calls).toHaveLength(1);
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

test("cost excludes failed attempts while owner spending retains them through streaming, retries and publication", async ({
  page,
  request,
  browser,
}) => {
  await request.post("/fixture/reset", {
    data: { costStreaming: true, holdGenerations: true },
  });
  try {
    await create(page, "Markdown", "cat\ndog", "hat");
    const cells = page.locator("article.cell");
    const total = page.locator(".grid-cost");
    const spent = page.locator(".grid-spent");
    const price = async (index: number) =>
      Number(
        (
          await cells
            .nth(index)
            .locator(".cell-usage > [data-tooltip]")
            .innerText()
        ).replace(/[^0-9.]/g, ""),
      );
    const tokenCounts = (index: number) =>
      cells.nth(index).locator(".cell-tokens");
    const tokens = async (index: number) => {
      const label = await tokenCounts(index).getAttribute("aria-label");
      return label!.match(/\d+/g)!.map(Number);
    };
    const release = (animal: string) =>
      request.post("/fixture/release", {
        data: { prompt: `Draw ${animal} wearing a hat` },
      });
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(2);
    await release("cat");
    await release("dog");
    await expect(cells.locator('[data-tooltip="Estimated cost"]')).toHaveCount(
      2,
    );
    const thinkingView = (index: number) =>
      cells.nth(index).getByRole("region", { name: /^Thinking:/ });
    await expect(thinkingView(0)).toContainText(
      "Thinking through the drawing.",
    );
    await expect(
      cells.nth(0).getByRole("button", { name: "Show output" }),
    ).toBeVisible();
    const reasoning = await price(0);
    expect(reasoning).toBeGreaterThan(0);
    await expect(tokenCounts(0)).toHaveAttribute("aria-label", /^Estimated:/);
    const [inputTokens, reasoningTokens] = await tokens(0);
    expect(inputTokens).toBeGreaterThan(0);
    expect(reasoningTokens).toBeGreaterThan(0);

    const expectTotal = async (formatted: string, estimated = true) => {
      await expect(total).toHaveAttribute(
        "aria-label",
        `Total cost: ${estimated ? "≈" : ""}${formatted}`,
      );
    };
    await expectTotal("$0.00");
    await expect(spent).toHaveAttribute(
      "aria-label",
      "Total spent: \u2248$0.00",
    );
    await release("cat");
    await expect.poll(() => price(0)).toBeGreaterThan(reasoning);
    await expect
      .poll(async () => (await tokens(0))[1])
      .toBeGreaterThan(reasoningTokens);
    expect((await tokens(0))[0]).toBe(inputTokens);

    await expectTotal("$0.01");
    await expect(thinkingView(0)).toBeHidden();
    await cells.nth(0).getByRole("button", { name: "Show thinking" }).click();
    await expect(thinkingView(0)).toContainText(
      "**Literal thinking** <b>not HTML</b>",
    );
    await cells.nth(0).getByRole("button", { name: "Expand thinking" }).click();
    await expect(
      page
        .getByRole("region", { name: /^Expanded output:/ })
        .getByRole("region", { name: /^Thinking:/ }),
    ).toContainText("Literal thinking");
    await page.getByRole("button", { name: "Collapse thinking" }).click();
    await release("cat");
    await expectProgress(page, 1, 2);
    await expect(
      cells.nth(0).locator('[data-tooltip="OpenRouter reported cost"]'),
    ).toHaveText("$0.019876");
    await expect(tokenCounts(0)).toHaveAttribute(
      "aria-label",
      "10 input tokens, 20 output tokens",
    );

    await expectTotal("$0.02");
    await expect(thinkingView(0)).toContainText(
      "**Literal thinking** <b>not HTML</b>",
    );
    await page.reload();
    await cells.nth(0).getByRole("button", { name: "Show thinking" }).click();
    await expect(thinkingView(0)).toContainText(
      "**Literal thinking** <b>not HTML</b>",
    );
    await expect(
      cells.nth(1).locator('[data-tooltip="Estimated cost"]'),
    ).toBeVisible();
    await expectTotal("$0.02");
    await expect(tokenCounts(1)).toHaveAttribute(
      "aria-label",
      `Estimated: ${inputTokens} input tokens, ${reasoningTokens} output tokens`,
    );
    const before = await price(1);
    await release("dog");
    await expect.poll(() => price(1)).toBeGreaterThan(before);
    await release("dog");
    await expect(cells.nth(1).locator(".cell-error")).toBeVisible();
    await expect(tokenCounts(1)).toHaveCount(0);
    await expectTotal("$0.01", false);
    await expect(spent).toHaveAttribute("aria-label", "Total spent: $0.03");
    await page.reload();
    await expectTotal("$0.01", false);
    await cells.nth(1).getByRole("button", { name: "Show thinking" }).click();
    await expect(thinkingView(1)).toContainText(
      "**Literal thinking** <b>not HTML</b>",
    );
    await expect(spent).toHaveAttribute("aria-label", "Total spent: $0.03");
    await cells.nth(1).getByRole("button", { name: "Show output" }).click();
    await page.getByRole("button", { name: "Resume generation" }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(1);
    await release("dog");
    await expectTotal("$0.02");
    await expect(spent).toHaveAttribute(
      "aria-label",
      "Total spent: \u2248$0.04",
    );
    await expect(tokenCounts(1)).toHaveAttribute(
      "aria-label",
      `Estimated: ${inputTokens} input tokens, ${reasoningTokens} output tokens`,
    );

    await release("dog");
    await expect.poll(() => price(1)).toBeGreaterThan(before);
    await release("dog");
    await expect(cells.nth(1).locator(".cell-error")).toBeVisible();
    await expect(tokenCounts(1)).toHaveCount(0);
    await expectTotal("$0.01", false);
    await expect(spent).toHaveAttribute("aria-label", "Total spent: $0.05");
    const history = await (await page.request.get("/api/billing")).json();
    expect(history.costUsd).toBeCloseTo(0.059876, 6);
    await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
    await finishPublishing(page);
    const viewer = await browser.newContext();
    try {
      const publicPage = await viewer.newPage();
      await publicPage.goto(page.url());
      await expect(publicPage.locator(".grid-cost")).toHaveAttribute(
        "aria-label",
        "Total cost: $0.01",
      );
      await expect(publicPage.locator(".grid-spent")).toHaveCount(0);
    } finally {
      await viewer.close();
    }
    await page.reload();
    await expect(spent).toHaveAttribute("aria-label", "Total spent: $0.05");
  } finally {
    await request.post("/fixture/release", { data: { all: true } });
  }
});

test("Markdown streams into its preview and preserves content and scroll while completion loads", async ({
  page,
  request,
}) => {
  const markdown =
    "# Streaming Markdown\n\n" +
    Array.from(
      { length: 120 },
      (_, i) => `Paragraph ${i} with **formatted text**.\n\n`,
    ).join("") +
    "## Finished\n";
  await request.post("/fixture/reset", {
    data: { markdownOutput: markdown, holdGenerations: true },
  });
  let releaseOutput: () => void = () => {};
  try {
    await create(page, "Markdown", "cat", "hat");
    const cell = page.locator("article.cell");
    const preview = cell.locator(".markdown-preview");
    await expect
      .poll(
        async () =>
          (await (await request.get("/fixture/workers")).json()).held.length,
      )
      .toBe(1);
    const next = () =>
      request.post("/fixture/release", {
        data: { prompt: "Draw cat wearing a hat" },
      });
    await next();
    await expect(
      preview.getByRole("heading", { name: "Streaming Markdown" }),
    ).toBeVisible();
    await expect(preview.locator("strong").first()).toHaveText(
      "formatted text",
    );
    await expectProgress(page, 0, 1);
    await cell.getByRole("button", { name: "View raw", exact: true }).click();
    const partial = (await preview.locator("pre").textContent())!;
    expect(partial).toContain("# Streaming Markdown");
    await next();
    await expect
      .poll(async () => (await preview.locator("pre").textContent())!.length)
      .toBeGreaterThan(partial.length);
    await cell
      .getByRole("button", { name: "View Markdown", exact: true })
      .click();
    await cell
      .getByRole("button", { name: "Expand Markdown", exact: true })
      .click();
    await expect(
      page
        .locator(".expanded-markdown")
        .getByRole("heading", { name: "Streaming Markdown" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Collapse Markdown", exact: true })
      .click();
    const document = (await preview
      .locator(".markdown-document")
      .elementHandle())!;
    await preview.evaluate((el) => {
      el.scrollTop = 80;
    });
    const scrollTop = await preview.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const gate = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    await page.route("**/outputs/*?raw=1", async (route) => {
      await gate;
      await route.continue();
    });
    const fetching = page.waitForRequest((request) =>
      request.url().includes("?raw=1"),
    );
    await request.post("/fixture/release", { data: { all: true } });
    await expectProgress(page, 1, 1);
    await fetching;
    expect(await document.evaluate((el) => el.isConnected)).toBe(true);
    await expect(
      preview.getByRole("heading", { name: "Streaming Markdown" }),
    ).toBeAttached();
    await expect(
      preview.getByText("Loading Markdown…", { exact: true }),
    ).toHaveCount(0);
    expect(await preview.evaluate((el) => el.scrollTop)).toBeCloseTo(
      scrollTop,
      0,
    );
    const loaded = page.waitForResponse((response) =>
      response.url().includes("?raw=1"),
    );
    releaseOutput();
    await loaded;
    await expect(
      preview.getByRole("heading", { name: "Finished", exact: true }),
    ).toBeAttached();
    expect(await document.evaluate((el) => el.isConnected)).toBe(true);
    expect(await preview.evaluate((el) => el.scrollTop)).toBeCloseTo(
      scrollTop,
      0,
    );
    await cell.getByRole("button", { name: "View raw", exact: true }).click();
    expect(await preview.locator("pre").textContent()).toBe(markdown);
  } finally {
    releaseOutput();
    await request.post("/fixture/release", { data: { all: true } });
  }
});
