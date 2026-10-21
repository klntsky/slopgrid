import { test, expect } from "./fixtures";
import { connectOpenRouter, expectProgress } from "./helpers";

test("a supported large reference survives reload, authorization and generation", async ({
  page,
  request,
}) => {
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/references")
      uploads.push(request.url());
  });
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
  await page
    .getByRole("combobox", { name: "Size", exact: true })
    .selectOption("custom");
  await page.getByLabel("Custom size width", { exact: true }).fill("1536");
  await page.reload();
  const preview = page.getByRole("img", { name: "large.png", exact: true });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  await connectOpenRouter(page);
  await expect(preview).toBeVisible();
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(
    page.getByLabel("Custom size width", { exact: true }),
  ).toHaveValue("1536");
  await expect(
    page.getByLabel("Custom size height", { exact: true }),
  ).toHaveValue("");
  await expect(generate).toBeDisabled();
  expect(uploads).toEqual([]);
  await page.getByLabel("Custom size height", { exact: true }).fill("1024");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent[0].input_references[0].image_url.url).toBe(
    `data:image/png;base64,${buffer.toString("base64")}`,
  );
});
