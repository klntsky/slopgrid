import { test, expect } from "./fixtures";
import { create, expectProgress, finishPublishing } from "./helpers";

const label = "Reuse existing artifacts from the previous version";
test("reuse selection survives Edit, reload, OAuth and Fork, and unchecked drafts regenerate every cell", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: label })).toHaveCount(0);
  await create(page, "Markdown", "dog", "hat");
  await expectProgress(page, 1, 1);
  const source = await (
    await page.request.get(`/api/grids/${page.url().split("/").pop()}`)
  ).json();
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
  await page.getByLabel("Row values").fill("dog\ncat");
  await request.post("/fixture/reset", { data: { holdGenerations: true } });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 1, 2);
  const id = page.url().split("/").pop();
  const current = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(current.cells[0].usage).toEqual(source.cells[0].usage);
  expect(current.cells[0].id).not.toBe(source.cells[0].id);
  await expect(page.locator(".markdown-preview:visible").first()).toContainText(
    "A generated cat",
  );
  await request.post("/fixture/release", { data: { all: true } });
  await expectProgress(page, 2, 2);
  const complete = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(complete.spentUsd).toBe(0.000123);
  expect(complete.cells.map((c: any) => c.usage)).toEqual([
    source.cells[0].usage,
    { inputTokens: 10, outputTokens: 20, costUsd: 0.000123 },
  ]);
  await expect(page.locator(".grid-cost")).toHaveAttribute(
    "aria-label",
    "Total cost: $0.00",
  );
  await expect(page.locator(".cell-tokens").first()).toHaveAttribute(
    "aria-label",
    "10 input tokens, 20 output tokens",
  );
  await expect(page.locator(".grid-spent")).toContainText("$0.00");
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
  async function generate(config: object) {
    const response = await page.request.post("/api/grids", { data: config });
    expect(response.status()).toBe(201);
    const grid = await response.json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/grids/${grid.id}`)).json())
            .status,
      )
      .toBe("complete");
    return (await page.request.get(`/api/grids/${grid.id}`)).json();
  }
  const source = await generate(input);
  let count = 2;
  const copied = await generate({
    ...input,
    sourceGridId: source.id,
    reuseArtifacts: true,
    rows: { kind: "input_references", values: ["Renamed", "Again"] },
    referenceGroups: { Renamed: [same, different], Again: [first, different] },
  });
  expect(
    (await (await request.get("/fixture/image-requests")).json()).length,
  ).toBe(count);
  expect(copied.cells.map((c: any) => c.usage)).toEqual(
    source.cells.map((c: any) => c.usage),
  );
  expect(copied.spentUsd).toBe(0);
  for (const cell of copied.cells) {
    expect(cell.mediaType).toBe("image/png");
    expect(await (await page.request.get(cell.outputURL)).body()).toEqual(png);
  }
  for (const change of [
    { referenceGroups: { A: [different, first], B: [different, same] } },
    { referenceGroups: { A: [first, first], B: [same, same] } },
    { columns: { kind: "size", values: ["2K"] } },
    { columns: { kind: "quality", values: ["high"] } },
    { columns: { kind: "background", values: ["transparent"] } },
    { columns: { kind: "aspect_ratio", values: ["16:9"] } },
  ]) {
    await generate({
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
  expect(sent[6].size).toBe("2K");
  expect(sent[8].quality).toBe("high");
  expect(sent[10].background).toBe("transparent");
  expect(sent[14 - 1].aspect_ratio).toBe("16:9");
});
