import type { Page } from "@playwright/test";
import type { ViewGrid } from "../../src/api";
import { currentDefinition } from "../current-grid-fixture";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  create,
  expectProgress,
  finishPublishing,
  editHeldGrid,
  forkReadonlyGrid,
  setVariableValues,
} from "./helpers";

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

async function unfinishedSource(page: Page, body: object, completed: number) {
  await page.request.post("/fixture/reset", {
    data: { holdGenerations: true },
  });
  const grid = await createGrid(page, body);
  await page.goto(`/grid/${grid.id}`);
  await expect
    .poll(async () => {
      const workers = await (await page.request.get("/fixture/workers")).json();
      for (const prompt of workers.held as string[])
        if (!prompt.includes("browser-pending"))
          await page.request.post("/fixture/release", { data: { prompt } });
      return (await readGrid(page, grid.id)).cells.filter(
        (cell) => cell.status === "complete",
      ).length;
    })
    .toBe(completed);
  await expectProgress(page, completed, completed + 1);
  await page
    .getByRole("button", { name: "Pause generation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume generation", exact: true }),
  ).toBeVisible();
  await page.request.post("/fixture/release", { data: { all: true } });
  return readGrid(page, grid.id);
}
const label = "Reuse existing artifacts from the previous version";
test("reuse selection survives unfinished Edit, reload and OAuth; unchecked drafts regenerate and published forks copy results", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { textCost: 0.25, holdGenerations: true },
  });
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: label })).toHaveCount(0);
  await create(page, {
    format: "Markdown",
    rowValues: ["dog", "source-pending"],
  });
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/workers")).json()).held.length,
    )
    .toBe(2);
  await request.post("/fixture/release", {
    data: { prompt: "Draw dog wearing a hat" },
  });
  await expectProgress(page, 1, 2);
  const source = await readGrid(page);
  await editHeldGrid(page);
  const reuse = page.getByRole("checkbox", { name: label });
  await expect(reuse).toBeChecked();
  await reuse.uncheck();
  await page.reload();
  await expect(reuse).not.toBeChecked();
  expect((await page.request.delete("/api/session/key")).status()).toBe(200);
  await page.reload();
  await connectOpenRouter(page);
  await expect(reuse).not.toBeChecked();
  await reuse.check();
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.5");
  await setVariableValues(page, "Rows", ["dog", "cat"]);
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
  await page.goto(`/grid/${source.id}`);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(page).toHaveURL("/create");
  await expect(reuse).toBeChecked();
  await setVariableValues(page, "Rows", ["dog", "cat"]);
  await page.getByLabel("Budget limit per cell", { exact: true }).fill("0.5");
  await reuse.uncheck();
  await page.reload();
  await expect(reuse).not.toBeChecked();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectProgress(page, 2, 2);
  expect((await readGrid(page)).spentUsd).toBe(0.5);
  await expect(page.locator(".grid-spent")).toHaveAttribute(
    "aria-label",
    "Total spent: $0.50",
  );
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await forkReadonlyGrid(page);
  await expect(reuse).toHaveCount(0);
  expect((await readGrid(page)).spentUsd).toBe(0);
  await expect(page.locator(".grid-cost")).toHaveAttribute(
    "aria-label",
    "Total cost: $0.50",
  );
});

test("image reuse follows ordered reference bytes and effective image settings through the provider SDK", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await connectOpenRouter(page);
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
  const input = currentDefinition({
    format: "image",
    caseAxes: ["rows"],
    budgetUsd: 5,
    parallelWorkers: 2,
    parameters: {
      input: {
        kind: "common",
        value: [{ role: "user", content: "Draw a landscape $ROW1" }],
      },
      size: { kind: "columns" },
    },
    rows: [
      { variable: [{ text: "", images: [first, different] }] },
      { variable: [{ text: "", images: [same, different] }] },
    ],
    columns: [{ size: "1K" }],
  });
  const source = await unfinishedSource(
    page,
    {
      ...input,
      rows: [...input.rows, { variable: [{ text: "browser-pending" }] }],
    },
    2,
  );
  const sourceRequests = await (
    await request.get("/fixture/image-requests")
  ).json();
  await request.post("/fixture/reset", { data: {} });
  let count = 0;
  const copied = await createGrid(page, {
    ...input,
    budgetUsd: 1,
    parameters: {
      ...input.parameters,
      size: { kind: "common", value: "1K" },
    },
    columns: [{ id: "column-1" }],
    sourceGridId: source.id,
    reuseArtifacts: true,
    rows: [
      {
        id: "row-1",
        variable: [{ text: "", images: [same, different] }],
      },
      {
        id: "row-2",
        variable: [{ text: "", images: [first, different] }],
      },
    ],
  });
  expect(
    (await (await request.get("/fixture/image-requests")).json()).length,
  ).toBe(count);
  expect(copied.cells.map((c) => c.usage)).toEqual(
    source.cells.slice(0, 2).map((c) => c.usage),
  );
  expect(copied.spentUsd).toBe(0);
  for (const cell of copied.cells) {
    expect(cell.mediaType).toBe("image/png");
    expect(cell.outputURL).toBeDefined();
    expect(await (await page.request.get(cell.outputURL!)).body()).toEqual(png);
  }
  for (const images of [
    [
      [different, first],
      [different, same],
    ],
    [
      [first, first],
      [same, same],
    ],
  ]) {
    await generate(page, {
      ...input,
      rows: input.rows.map((row, index) => ({
        ...row,
        variable: [{ text: "", images: images[index] }],
      })),
      sourceGridId: source.id,
      reuseArtifacts: true,
    });
    count += 2;
    expect(
      (await (await request.get("/fixture/image-requests")).json()).length,
    ).toBe(count);
  }
  const sent = await (await request.get("/fixture/image-requests")).json();
  expect(sent[0].input_references[0].image_url.url).toBe(
    sourceRequests[0].input_references[1].image_url.url,
  );
});

for (const [kind, initial, changed] of [
  ["size", "1K", "2K"],
  ["quality", "low", "high"],
  ["background", "opaque", "transparent"],
  ["aspect_ratio", "1:1", "16:9"],
] as const) {
  test(`image reuse invalidates a cached artifact when the ${kind} axis changes`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: {} });
    await page.goto("/");
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await connectOpenRouter(page);
    const config = currentDefinition({
      format: "image",
      caseAxes: ["rows"],
      budgetUsd: 5,
      parameters: {
        input: {
          kind: "common",
          value: [{ role: "user", content: "Draw $ROW1" }],
        },
        [kind]: { kind: "columns" },
      },
      rows: [{ variable: [{ text: "landscape" }] }],
      columns: [{ [kind]: initial }],
    });
    const source = await unfinishedSource(
      page,
      {
        ...config,
        rows: [...config.rows, { variable: [{ text: "browser-pending" }] }],
      },
      1,
    );
    const sourceRequests = await (
      await request.get("/fixture/image-requests")
    ).json();
    expect(sourceRequests[0][kind]).toBe(initial);
    await request.post("/fixture/reset", { data: {} });
    const reuse = { ...config, sourceGridId: source.id, reuseArtifacts: true };
    const copy = await createGrid(page, reuse);
    expect(copy.status).toBe("complete");
    expect(
      await (await request.get("/fixture/image-requests")).json(),
    ).toHaveLength(0);
    await generate(page, {
      ...reuse,
      columns: [{ id: "column-1", [kind]: changed }],
    });
    const sent = await (await request.get("/fixture/image-requests")).json();
    expect(sent).toHaveLength(1);
    expect(sent[0][kind]).toBe(changed);
  });
}
