import { test, expect } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("case cells allow vertical page scrolling and local horizontal touch panning", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("combobox", { name: "Rows", exact: true }).selectOption("variable");
  for (let index = 0; index < 3; index++)
    await page.getByRole("button", { name: "new variable", exact: true }).click();
  const region = page.getByRole("region", {
    name: "Editable case parameters; scroll for more cases and fields",
    exact: true,
  });
  const field = page.getByLabel("$ROW1, case 1", { exact: true });
  await field.scrollIntoViewIfNeeded();
  const client = await page.context().newCDPSession(page);
  const swipe = async (x: number, y: number, dx: number, dy: number) => {
    let timestamp = Date.now() / 1000;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
      timestamp,
    });
    for (let step = 1; step <= 6; step++)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 6, y: y + (dy * step) / 6, id: 1 }],
        timestamp: (timestamp += 0.032),
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: timestamp + 0.2,
    });
  };
  try {
    const box = (await field.boundingBox())!;
    const initialPageY = await page.evaluate(() => window.scrollY);
    await swipe(Math.min(box.x + box.width / 2, 330), box.y + 30, -130, 0);
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(60);
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(initialPageY, 0);
    await region.evaluate((element) => { element.scrollLeft = 0; });
    await field.scrollIntoViewIfNeeded();
    expect(await region.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    const verticalBox = (await field.boundingBox())!;
    const beforePageY = await page.evaluate(() => window.scrollY);
    await swipe(Math.min(verticalBox.x + verticalBox.width / 2, 330), verticalBox.y + 30, 0, -130);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforePageY + 40);
  } finally {
    await client.detach();
  }
});
