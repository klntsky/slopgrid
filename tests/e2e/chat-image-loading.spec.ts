import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  selectModel,
  setVariableValues,
} from "./helpers";
import { rasterizeSvg } from "../../server/svg-raster";

test.use({ serviceWorkers: "block" });

test("chat images reserve their proportions through delayed loads and failures", async ({
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
  let landscapeId = "";
  let portraitId = "";
  let metadataReady!: () => void;
  let loadLandscape!: () => void;
  let failPortrait!: () => void;
  const metadata = new Promise<void>((resolve) => {
    metadataReady = resolve;
  });
  const landscapeGate = new Promise<void>((resolve) => {
    loadLandscape = resolve;
  });
  const portraitGate = new Promise<void>((resolve) => {
    failPortrait = resolve;
  });
  await page.route("**/api/references/*", async (route) => {
    await metadata;
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (id === landscapeId) {
      await landscapeGate;
      await route.continue();
    } else if (id === portraitId) {
      await portraitGate;
      await route.fulfill({ status: 404, body: "Unavailable image" });
    } else await route.continue();
  });
  try {
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
      .fill("Compare these images $ROW1 $COLUMN1");
    await page
      .getByLabel("Add images to message 1", { exact: true })
      .setInputFiles([
        {
          name: "landscape.png",
          mimeType: "image/png",
          buffer: landscape.bytes,
        },
        { name: "portrait.png", mimeType: "image/png", buffer: portrait.bytes },
      ]);
    await expect(
      page.getByRole("img", { name: "portrait.png", exact: true }),
    ).toBeVisible();
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await page
      .getByLabel("Message 3", { exact: true })
      .fill("Keep this later turn in place.");
    await page.locator(".chat-append").hover();
    await page
      .getByRole("button", { name: "Add message", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Rows", exact: true })
      .selectOption("variable");
    await setVariableValues(page, "Rows", ["one"]);
    await page
      .getByRole("combobox", { name: "Columns", exact: true })
      .selectOption("variable");
    await setVariableValues(page, "Columns", ["two"]);
    await selectModel(page, "fixture/text");
    const uploaded = (name: string) =>
      page
        .waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname === "/api/references" &&
            url.searchParams.get("name") === name
          );
        })
        .then((response) => response.json());
    const uploads = Promise.all([
      uploaded("landscape.png"),
      uploaded("portrait.png"),
    ]);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const references = await uploads;
    landscapeId = references[0].id;
    portraitId = references[1].id;
    metadataReady();
    await expectProgress(page, 1, 1);
    const conversation = page.locator(".chat-conversation").first();
    const frames = conversation.locator(".chat-image-frame");
    const rows = conversation.locator(".chat-message-row");
    await expect(rows).toHaveCount(4);
    await expect(frames).toHaveCount(2);
    for (const frame of await frames.all()) {
      await expect(frame).toHaveAttribute("aria-busy", "true");
      await expect(frame.getByRole("progressbar")).toBeVisible();
    }
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
    loadLandscape();
    await expect(frames.nth(0)).toHaveAttribute("aria-busy", "false");
    await expect(frames.nth(0).locator("img")).toHaveJSProperty(
      "naturalWidth",
      800,
    );
    await expect(frames.nth(0).getByRole("progressbar")).toHaveCount(0);
    expect(await geometry()).toEqual(before);
    await expect(frames.nth(1).getByRole("progressbar")).toBeVisible();
    failPortrait();
    await expect(frames.nth(1)).toHaveAttribute("aria-busy", "false");
    await expect(frames.nth(1).locator("img")).toHaveJSProperty(
      "complete",
      true,
    );
    await expect(frames.nth(1).locator("img")).toHaveJSProperty(
      "naturalWidth",
      0,
    );
    await expect(frames.nth(1).getByRole("progressbar")).toHaveCount(0);
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
  } finally {
    metadataReady();
    loadLandscape();
    failPortrait();
  }
  const outputURL = await page
    .getByRole("link", { name: "Open output", exact: true })
    .first()
    .getAttribute("href");
  const standalone = await page.context().newPage();
  try {
    await standalone.goto(new URL(outputURL!, page.url()).href);
    await expect(standalone.locator(".chat-image-frame")).toHaveCount(2);
    await expect(standalone.getByRole("progressbar")).toHaveCount(0);
    await expect(
      standalone.getByRole("img", { name: "landscape.png", exact: true }),
    ).toHaveJSProperty("naturalWidth", 800);
    await expect(
      standalone.getByRole("img", { name: "portrait.png", exact: true }),
    ).toHaveJSProperty("naturalWidth", 240);
  } finally {
    await standalone.close();
  }
});
