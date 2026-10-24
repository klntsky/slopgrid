import { test, expect } from "@playwright/test";
import { runtimeFixture, kill } from "../runtime-fixture";
import { currentDefinition } from "../current-grid-fixture";

for (const entry of ["reload", "refetch", "pause", "edit"] as const) {
  test(`generation service outage recovers automatically after ${entry}`, async ({
    playwright,
  }) => {
    const fixture = await runtimeFixture();
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          name: fixture.cookieName,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          value: fixture.owner,
          url: fixture.origin,
        },
      ]);
      const grid = fixture.grid();
      const page = await context.newPage();
      let unavailableReads = 0;
      page.on("response", (response) => {
        if (
          new URL(response.url()).pathname === `/api/grids/${grid.id}` &&
          response.request().method() === "GET" &&
          response.status() === 503
        )
          unavailableReads++;
      });
      await page.goto(`${fixture.origin}/grid/${grid.id}`);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const call = await fixture.nextCall();
      call.write({ content: "Saved before service outage." });
      call.finish();
      const preview = page.locator(".markdown-preview:visible").first();
      await expect(preview).toContainText("Saved before service outage.");
      await fixture.nextCall();
      await expect(
        page.getByRole("progressbar", { name: "Grid generation" }),
      ).toHaveAttribute("value", "1");
      const document = await preview.elementHandle();
      await kill(fixture.engine.child);
      if (entry === "reload") {
        await page.reload();
      } else {
        const failure = page.waitForResponse(
          (response) =>
            response.url().includes(`/api/grids/${grid.id}`) &&
            response.status() === 503,
        );
        if (entry === "refetch")
          await page.evaluate(() =>
            window.dispatchEvent(new Event("visibilitychange")),
          );
        else
          await page
            .getByRole("button", {
              name: entry === "pause" ? "Pause generation" : "EDIT",
              exact: true,
            })
            .click();
        await failure;
        await expect(preview).toContainText("Saved before service outage.");
        expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
      }
      await expect(page.locator(".connection-status")).toContainText(
        "Connection lost. Reconnecting",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "slopgrid", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => unavailableReads, { timeout: 10000 })
        .toBeGreaterThan(4);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const outageDocument = await page.locator("html").elementHandle();
      await fixture.startEngine();
      await expect(preview).toContainText("Saved before service outage.", {
        timeout: 15000,
      });
      await expect(page.locator(".connection-status")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(await outageDocument!.evaluate((node) => node.isConnected)).toBe(
        true,
      );
      await expect(
        page.getByRole("button", { name: "Resume generation" }),
      ).toBeVisible();
      expect(fixture.calls).toHaveLength(2);
      await page.getByRole("button", { name: "Resume generation" }).click();
      const resumed = await fixture.nextCall();
      resumed.write({ content: "After service recovery." });
      resumed.finish();
      await expect(
        page.locator(".markdown-preview:visible").last(),
      ).toContainText("After service recovery.");
      await expect(
        page.getByRole("progressbar", { name: "Grid generation" }),
      ).toHaveAttribute("value", "2");
      expect(fixture.calls).toHaveLength(3);
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}

test("grid recovery stops on navigation and missing grids remain terminal", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid();
    await kill(fixture.engine.child);
    const page = await context.newPage();
    await page.clock.install();
    let gridReads = 0;
    let missingReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/grids/${grid.id}`) gridReads++;
      if (path === `/api/grids/${"0".repeat(48)}`) missingReads++;
    });
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    await expect(page.locator(".connection-status")).toBeVisible();
    await page.getByRole("link", { name: "slopgrid", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create your own AI model benchmark" }),
    ).toBeVisible();
    const readsBeforeAdvancing = gridReads;
    await page.clock.runFor(5000);
    expect(gridReads).toBe(readsBeforeAdvancing);
    await page.goto(`${fixture.origin}/grid/${"0".repeat(48)}`);
    await expect(page.getByRole("alert")).toContainText("Grid not found");
    await page.clock.runFor(10000);
    expect(missingReads).toBe(1);
    await expect(page.locator(".connection-status")).toHaveCount(0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("open browsers reconnect to a replaced web process while markdown, thinking and website assets continue streaming", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture({ workers: 2 });
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: "__Host-slopgrid",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const markdown = fixture.grid({
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "markdown" }] }],
    });
    const website = fixture.grid({
      format: "html",
      caseAxes: ["rows"],
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
      },
      rows: [{ variable: [{ text: "website" }] }],
    });
    const pages = [await context.newPage(), await context.newPage()];
    for (const [index, grid] of [markdown, website].entries()) {
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
      (await fixture.call(index)).write({ reasoning: "Before restart. " });
      await pages[index].goto(`${fixture.origin}/grid/${grid.id}`);
      await expect(
        pages[index].getByRole("region", { name: /^Thinking:/ }),
      ).toContainText("Before restart.");
    }
    const [md, html] = pages;
    const [mdCall, htmlCall] = fixture.calls;
    mdCall.write({ content: "# Before restart\n\n" });
    const first =
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Website survived</h1><p id="module">Waiting</p><script type="module" src="app.js"></script>';
    htmlCall.write({
      content:
        '{"files":[{"path":"index.html","content":' + JSON.stringify(first),
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "Before restart",
    );
    await expect(
      html.frameLocator("iframe:visible").getByRole("heading"),
    ).toHaveText("Website survived");
    // These document handles also prove recovery happens without a page reload.
    const documents = await Promise.all(
      pages.map((p) => p.locator("html").elementHandle()),
    );
    await kill(fixture.web);
    mdCall.write({
      reasoning: "During downtime. ",
      content: "During downtime.\n\n",
    });
    await fixture.startWeb();
    htmlCall.write({
      reasoning: "After restart.",
      content:
        '},{"path":"style.css","content":"body { color: rgb(12, 34, 56); }"},{"path":"app.js","content":' +
        JSON.stringify(
          "document.getElementById('module').textContent='Module after restart';",
        ),
    });
    mdCall.write({
      reasoning: "After restart.",
      content: "## After restart\n",
    });
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "After restart",
    );
    const frame = html.frameLocator("iframe:visible");
    await expect(frame.getByText("Module after restart")).toBeVisible();
    // Check that the generated stylesheet was fetched by the new web process.
    await expect(frame.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
    for (const p of pages) {
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
      await expect(p.getByRole("region", { name: /^Thinking:/ })).toContainText(
        "After restart.",
      );
      await p
        .getByRole("button", { name: "Show thinking", exact: true })
        .click();
    }
    mdCall.finish();
    htmlCall.write({ content: "}]}" });
    htmlCall.finish();
    for (const p of pages)
      await expect(p.locator(".grid-cost")).toHaveAttribute(
        "aria-label",
        "Total cost: $0.01",
      );
    await expect(md.locator(".markdown-preview:visible")).toContainText(
      "During downtime.",
    );
    await expect(frame.getByText("Module after restart")).toBeVisible();
    for (const document of documents)
      expect(await document!.evaluate((el) => el.isConnected)).toBe(true);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.aborted)).toEqual([false, false]);
    expect(fixture.store.billing.page(fixture.owner, 0).costUsd).toBe(0.0246);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("running chat output stays readable offline and catches up after reconnecting", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const grid = fixture.grid(
      currentDefinition({
        format: "chat-template",
        budgetUsd: 0.1,
        parameters: {
          input: {
            kind: "common",
            value: [
              { role: "user", content: "Keep this conversation visible." },
              { role: "unfilled", content: "" },
            ],
          },
          effort: { kind: "common", value: "none" },
        },
      }),
    );
    await fixture.engine.api.startGrid({
      gridId: grid.id,
      sessionId: fixture.owner,
    });
    const call = await fixture.nextCall();
    call.write({ content: "Before disconnect. " });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/grid/${grid.id}`);
    const preview = page.locator(".conversation-preview");
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    const document = await preview.elementHandle();

    await context.setOffline(true);
    await expect(preview).toBeVisible();
    await expect(preview.locator('[data-role="user"]')).toHaveText(
      "Keep this conversation visible.",
    );
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect.",
    );
    await expect(page.locator(".connection-status")).toContainText(
      "Connection lost. Reconnecting",
    );
    expect(await document!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await expect(page.locator(".markdown-raw")).toContainText(
      "Before disconnect.",
    );
    await page.getByRole("button", { name: "View raw", exact: true }).click();
    await page
      .getByRole("button", { name: "Expand Chat completion", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: /^Expanded output:/ }),
    ).toContainText("Before disconnect.");
    await page
      .getByRole("button", { name: "Collapse Chat completion", exact: true })
      .click();

    call.write({ content: "During disconnect. " });
    await context.setOffline(false);
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect.",
    );
    await expect(page.locator(".connection-status")).toHaveCount(0);
    call.write({ content: "After reconnect." });
    call.finish();
    await expect(preview.locator('[data-role="assistant"]')).toHaveText(
      "Before disconnect. During disconnect. After reconnect.",
    );
    await expect(
      page.getByRole("link", { name: "Open output", exact: true }),
    ).toBeVisible();
    expect(fixture.calls).toHaveLength(1);
    expect(call.aborted).toBe(false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("loaded SVG, website and image output survives disconnection without losing website state", async ({
  playwright,
}) => {
  const fixture = await runtimeFixture({ workers: 3, images: true });
  const browser = await playwright.chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.slopgrid.test 127.0.0.1, MAP slopgrid.test 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: fixture.cookieName,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        value: fixture.owner,
        url: fixture.origin,
      },
    ]);
    const svg = fixture.grid({
      format: "svg",
      rows: [{ variable: [{ text: "svg" }] }],
    });
    const website = fixture.grid({
      format: "html",
      rows: [{ variable: [{ text: "website" }] }],
    });
    const image = fixture.grid(
      currentDefinition({
        format: "image",
        budgetUsd: 0.1,
        parameters: {
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw image" }],
          },
        },
      }),
    );
    for (const grid of [svg, website, image])
      await fixture.engine.api.startGrid({
        gridId: grid.id,
        sessionId: fixture.owner,
      });
    const svgCall = await fixture.nextCall();
    const websiteCall = await fixture.nextCall();
    svgCall.write({
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/>',
    });
    websiteCall.write({
      content:
        '{"files":[{"path":"index.html","content":' +
        JSON.stringify(
          '<h1>Loaded website</h1><input aria-label="Local state">',
        ).slice(0, -1),
    });
    (await fixture.nextImageCall()).finish(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const [svgPage, websitePage, imagePage] = await Promise.all(
      [svg, website, image].map(async (grid) => {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/grid/${grid.id}`);
        return page;
      }),
    );
    const svgPreview = svgPage.getByRole("img", { name: "SVG preview" });
    const imageOutput = imagePage.getByRole("img", { name: "Generated image" });
    await expect(svgPreview).toBeVisible();
    await expect
      .poll(() =>
        imageOutput.evaluate((element) =>
          element instanceof HTMLImageElement ? element.naturalWidth : 0,
        ),
      )
      .toBe(1);
    const frame = websitePage.frameLocator('iframe[aria-hidden="false"]');
    await frame.getByRole("textbox", { name: "Local state" }).fill("Keep me");
    const websiteDocument = await frame.locator("html").elementHandle();
    const svgElement = await svgPreview.elementHandle();
    const imageElement = await imageOutput.elementHandle();

    await context.setOffline(true);
    await expect(svgPreview).toBeVisible();
    await expect(imageOutput).toBeVisible();
    await expect(frame.getByRole("heading")).toHaveText("Loaded website");
    await expect(frame.getByRole("textbox")).toHaveValue("Keep me");
    for (const element of [svgElement, imageElement, websiteDocument])
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
    for (const page of [svgPage, websitePage])
      await expect(page.locator(".connection-status")).toContainText(
        "Connection lost. Reconnecting",
      );

    svgCall.write({
      content: '<circle cx="20" cy="20" r="10" fill="blue"/></svg>',
    });
    svgCall.finish();
    websiteCall.write({ content: '<p>After reconnect</p>"}]}' });
    websiteCall.finish();
    await context.setOffline(false);
    await expect(
      svgPage.getByRole("img", { name: "Generated SVG" }),
    ).toBeVisible();
    await expect(frame.getByText("After reconnect")).toBeVisible();
    await expect(websitePage.locator(".connection-status")).toHaveCount(0);
    await expect(
      websitePage.getByRole("link", { name: "Open output", exact: true }),
    ).toBeVisible();
    const outputURL = await websitePage
      .getByRole("link", { name: "Open output", exact: true })
      .getAttribute("href");
    await expect(
      websitePage.locator('iframe[aria-hidden="false"]'),
    ).toHaveAttribute("src", outputURL!);

    // A completed website must retain its live document, not load a cached copy.
    await frame.getByRole("textbox").fill("Completed local state");
    const completedDocument = await frame.locator("html").elementHandle();
    await context.setOffline(true);
    await expect(frame.getByRole("textbox")).toHaveValue(
      "Completed local state",
    );
    expect(await completedDocument!.evaluate((node) => node.isConnected)).toBe(
      true,
    );
    await context.setOffline(false);
    await expect(frame.getByRole("textbox")).toHaveValue(
      "Completed local state",
    );
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.every((call) => !call.aborted)).toBe(true);
    expect(fixture.imageCalls).toHaveLength(1);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
