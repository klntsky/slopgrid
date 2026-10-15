import { test, expect } from "./fixtures";
import { expectProgress } from "./helpers";

test("a supported large reference survives reload and authorization without storing its bytes in the draft", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Fixture image", exact: true })
    .check();
  await page.getByLabel("Prompt", { exact: true }).fill("Draw a landscape");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const buffer = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
  await page
    .getByLabel("Add input references", { exact: true })
    .setInputFiles({ name: "large.png", mimeType: "image/png", buffer });
  await expect(
    page.getByRole("img", { name: "large.png", exact: true }),
  ).toBeVisible();
  await page.reload();
  const preview = page.getByRole("img", { name: "large.png", exact: true });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem("slopgrid-draft")!.length),
  ).toBeLessThan(4096);
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent).toHaveLength(1);
  expect(sent[0].input_references[0].image_url.url).toBe(
    `data:image/png;base64,${buffer.toString("base64")}`,
  );
});
