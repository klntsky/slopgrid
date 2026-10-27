import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  selectModel,
  setVariableValues,
} from "./helpers";
import { rasterizeSvg } from "../../server/svg-raster";

test.use({ serviceWorkers: "block" });

test("inline chat images preserve proportions through loading failures without reference requests", async ({
  page,
  request,
}) => {
  const [landscape, portrait] = await Promise.all([
    rasterizeSvg(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="red"/></svg>',
      ),
    ),
    rasterizeSvg(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="480"><rect width="240" height="480" fill="blue"/></svg>',
      ),
    ),
  ]);
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Stable answer." },
  });
  await page.goto("/create");
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .click();
  await connectOpenRouter(page);
  await page
    .getByLabel("Message 1", { exact: true })
    .fill("Compare these images $ROW1 two");
  await page
    .getByLabel("Add images to message 1", { exact: true })
    .setInputFiles([
      { name: "landscape.png", mimeType: "image/png", buffer: landscape.bytes },
      { name: "portrait.png", mimeType: "image/png", buffer: portrait.bytes },
    ]);
  await expect(
    page.getByRole("img", { name: "portrait.png", exact: true }),
  ).toBeVisible();
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByLabel("Message 3", { exact: true })
    .fill("Keep this later turn in place.");
  await page.locator(".chat-append").hover();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["one"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  const columns = page.getByRole("group", {
    name: "Column values",
    exact: true,
  });
  for (const checkbox of await columns
    .locator('input[type="checkbox"]:checked')
    .all())
    await checkbox.uncheck();
  await columns
    .getByRole("checkbox", { name: "Model default", exact: true })
    .check();
  await selectModel(page, "fixture/text");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const referenceRequests: string[] = [];
  await page.route("**/api/references/*", async (route) => {
    referenceRequests.push(route.request().url());
    await route.abort();
  });
  await page.reload();
  const conversation = page.locator(".chat-conversation").first();
  const frames = conversation.locator(".chat-image-frame");
  const rows = conversation.locator(".chat-message-row");
  await expect(rows).toHaveCount(4);
  await expect(frames).toHaveCount(2);
  for (const [index, width] of [800, 240].entries()) {
    await expect(frames.nth(index).locator("img")).toHaveJSProperty(
      "naturalWidth",
      width,
    );
    await expect(frames.nth(index).locator("img")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await expect(frames.nth(index)).toHaveAttribute("aria-busy", "false");
  }
  await expect(conversation.getByRole("progressbar")).toHaveCount(0);
  for (const [index, ratio] of [2, 0.5].entries()) {
    const box = (await frames.nth(index).boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(ratio, 2);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(async () => (await rows.first().boundingBox())!.width)
    .toBeLessThanOrEqual(390);
  const geometry = () =>
    rows.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  const before = await geometry();
  const imageNetwork = await page.context().newCDPSession(page);
  await imageNetwork.send("Network.enable");
  await imageNetwork.send("Network.setBlockedURLs", {
    urls: [`data:image/png;base64,${portrait.bytes.toString("base64")}`],
  });
  await page.reload();
  await expect(rows).toHaveCount(4);
  await expect(frames).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(frames.first().locator("img")).toHaveJSProperty(
    "naturalWidth",
    800,
  );
  await expect(frames.nth(1).locator("img")).toHaveJSProperty("complete", true);
  await expect(frames.nth(1).locator("img")).toHaveJSProperty(
    "naturalWidth",
    0,
  );
  await expect(frames.nth(1)).toHaveAttribute("aria-busy", "false");
  expect(await geometry()).toEqual(before);
  await page
    .getByRole("button", { name: "Expand Chat completion", exact: true })
    .click();
  await expect(page.locator(".chat-image-frame[aria-busy=true]")).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Collapse Chat completion", exact: true })
    .click();
  expect(referenceRequests).toEqual([]);
  const outputURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .first()
    .getAttribute("href");
  const standalone = await page.context().newPage();
  try {
    await standalone.route("**/api/references/*", async (route) => {
      referenceRequests.push(route.request().url());
      await route.abort();
    });
    await standalone.goto(new URL(outputURL!, page.url()).href);
    await expect(standalone.locator(".chat-image-frame")).toHaveCount(2);
    await expect(standalone.getByRole("progressbar")).toHaveCount(0);
    await expect(
      standalone.getByRole("img", { name: "landscape.png", exact: true }),
    ).toHaveJSProperty("naturalWidth", 800);
    await expect(
      standalone.getByRole("img", { name: "portrait.png", exact: true }),
    ).toHaveJSProperty("naturalWidth", 240);
    expect(referenceRequests).toEqual([]);
  } finally {
    await standalone.close();
    await imageNetwork.detach();
  }
});
