import { test, expect } from "./fixtures";
import { expectProgress } from "./helpers";

test("a later failed upload preserves earlier references across reload and retry", async ({
  page,
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
  await page.getByLabel("Add input references", { exact: true }).setInputFiles(
    ["first.png", "second.png"].map((name) => ({
      name,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(
    page.getByRole("img", { name: "second.png", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  const uploads: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (req.method() === "POST" && url.pathname === "/api/references")
      uploads.push(url.searchParams.get("name")!);
  });
  await page.route("**/api/references?name=second.png", (route) =>
    route.fulfill({ status: 503, json: { error: "Storage unavailable" } }),
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not upload second.png.",
  );
  await page.reload();
  await page.unroute("**/api/references?name=second.png");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 1);
  const grid = await (
    await page.request.get(
      `/api${new URL(page.url()).pathname.replace("/grid/", "/grids/")}`,
    )
  ).json();
  expect(grid.cells.map((cell: { error?: string }) => cell.error)).toEqual([
    undefined,
  ]);
  expect(uploads).toEqual(["first.png", "second.png", "second.png"]);
});
