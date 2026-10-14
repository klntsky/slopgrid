import type { Page } from "@playwright/test";
import type { ViewGrid } from "../../src/api";
import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

async function readGrid(
  page: Page,
  id = page.url().split("/").pop()!,
): Promise<ViewGrid> {
  return (await page.request.get(`/api/grids/${id}`)).json();
}
async function createGrid(page: Page, body: object): Promise<ViewGrid> {
  const response = await page.request.post("/api/grids", { data: body });
  expect(response.status()).toBe(201);
  return response.json();
}
async function generate(page: Page, body: object): Promise<ViewGrid> {
  const grid = await createGrid(page, body);
  await expect
    .poll(async () => (await readGrid(page, grid.id)).status)
    .toBe("complete");
  return readGrid(page, grid.id);
}
const label = "Reuse existing artifacts from the previous version";
test("reuse selection survives Edit, reload, OAuth and Fork, and unchecked drafts regenerate every cell", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { textCost: 0.25 } });
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: label })).toHaveCount(0);
  await create(page, "Markdown", "dog", "hat");
  await expectProgress(page, 1, 1);
  const source = await readGrid(page);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  const reuse = page.getByRole("checkbox", { name: label });
  await expect(reuse).toBeChecked();
  await reuse.uncheck();
  await page.reload();
  await expect(reuse).not.toBeChecked();
  expect((await page.request.delete("/api/session/key")).status()).toBe(200);
  await page.reload();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(reuse).not.toBeChecked();
  await reuse.check();
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.5");
  await page.getByLabel("Row values").fill("dog\ncat");
  await request.post("/fixture/reset", {
    data: { holdGenerations: true, textCost: 0.25 },
  });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 2);
  const id = page.url().split("/").pop();
  const current = await readGrid(page, id);
  expect(current.cells[0].usage).toEqual(source.cells[0].usage);
  expect(current.cells[0].id).not.toBe(source.cells[0].id);
  await expect(page.locator(".markdown-preview:visible").first()).toContainText(
    "A generated cat",
  );
  await request.post("/fixture/release", { data: { all: true } });
  await expectProgress(page, 2, 2);
  const complete = await readGrid(page, id);
  expect(complete.spentUsd).toBe(0.25);
  expect(complete.cells.map((c) => c.usage)).toEqual([
    source.cells[0].usage,
    { inputTokens: 10, outputTokens: 20, costUsd: 0.25 },
  ]);
  await expect(page.locator(".grid-cost")).toHaveAttribute(
    "aria-label",
    "Total cost: $0.50",
  );
  await expect(page.locator(".cell-tokens").first()).toHaveAttribute(
    "aria-label",
    "10 input tokens, 20 output tokens",
  );
  await expect(page.locator(".grid-spent")).toContainText("$0.25");
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await reuse.uncheck();
  await page.reload();
  await expect(reuse).not.toBeChecked();
  const before = await (await request.get("/fixture/calls")).json();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  const after = await (await request.get("/fixture/calls")).json();
  expect(after.length - before.length).toBe(2);
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expect(reuse).toBeChecked();
  await page.reload();
  await expect(reuse).toBeChecked();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  expect(await (await request.get("/fixture/calls")).json()).toEqual(after);
});

test("image reuse follows ordered reference bytes and effective image settings through the provider SDK", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByRole("link", { name: "Connect OpenRouter" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  async function upload(bytes: Buffer, name: string) {
    const response = await page.request.post(`/api/references?name=${name}`, {
      headers: { "content-type": "application/octet-stream" },
      data: bytes,
    });
    expect(response.status()).toBe(201);
    return response.json();
  }
  const first = await upload(png, "first.png"),
    same = await upload(png, "renamed.png"),
    different = await upload(
      Buffer.concat([png, Buffer.from("different")]),
      "second.png",
    );
  const input = {
    format: "image",
    prompt: "Draw a landscape",
    model: "fixture/image",
    effort: "default",
    budgetUsd: 5,
    parallelWorkers: 2,
    rows: { kind: "input_references", values: ["A", "B"] },
    columns: { kind: "size", values: ["1K"] },
    referenceGroups: { A: [first, different], B: [same, different] },
  };
  const source = await generate(page, input);
  let count = 2;
  const copied = await createGrid(page, {
    ...input,
    budgetUsd: 1,
    effort: "high",
    sourceGridId: source.id,
    reuseArtifacts: true,
    rows: { kind: "input_references", values: ["Renamed", "Again"] },
    referenceGroups: { Renamed: [same, different], Again: [first, different] },
  });
  expect(
    (await (await request.get("/fixture/image-requests")).json()).length,
  ).toBe(count);
  expect(copied.cells.map((c) => c.usage)).toEqual(
    source.cells.map((c) => c.usage),
  );
  expect(copied.spentUsd).toBe(0);
  for (const cell of copied.cells) {
    expect(cell.mediaType).toBe("image/png");
    expect(cell.outputURL).toBeDefined();
    expect(await (await page.request.get(cell.outputURL!)).body()).toEqual(png);
  }
  for (const change of [
    { referenceGroups: { A: [different, first], B: [different, same] } },
    { referenceGroups: { A: [first, first], B: [same, same] } },
  ]) {
    await generate(page, {
      ...input,
      ...change,
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    count += 2;
    expect(
      (await (await request.get("/fixture/image-requests")).json()).length,
    ).toBe(count);
  }
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent[2].input_references[0].image_url.url).toBe(
    sent[0].input_references[1].image_url.url,
  );
});

for (const [kind, initial, changed] of [
  ["size", "1K", "2K"],
  ["quality", "low", "high"],
  ["background", "opaque", "transparent"],
  ["aspect_ratio", "1:1", "16:9"],
] as const) {
  test(`image reuse changes only ${kind} while keeping every other parameter fixed`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: {} });
    await page.goto("/");
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await page.getByRole("link", { name: "Connect OpenRouter" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const config = {
      format: "image",
      prompt: "Draw $ROW",
      model: "fixture/image",
      effort: "default",
      budgetUsd: 5,
      rows: { kind: "variable", values: ["landscape"] },
      columns: { kind, values: [initial] },
    };
    const source = await generate(page, config);
    const reuse = { ...config, sourceGridId: source.id, reuseArtifacts: true };
    const copy = await createGrid(page, reuse);
    expect(copy.status).toBe("complete");
    expect(
      await (await request.get("/fixture/image-requests")).json(),
    ).toHaveLength(1);
    await generate(page, { ...reuse, columns: { kind, values: [changed] } });
    const sent = await (await request.get("/fixture/image-requests")).json();
    expect(sent).toHaveLength(2);
    expect(sent[0][kind]).toBe(initial);
    expect(sent[1]).toEqual({ ...sent[0], [kind]: changed });
  });
}
