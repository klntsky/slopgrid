import { test, expect, type Page } from "@playwright/test";
import type { Cell, GridInput } from "../../server/domain";
import type { Model } from "../../server/provider";
import type { BillingPage } from "../../server/billing";

const judges = ["openai/gpt-5-mini", "openai/gpt-5-nano"];
const textGenerator = "openai/gpt-4.1-mini";
const imageGenerator = "google/gemini-2.5-flash-image";
const criteria = [
  {
    text: "Does the output contain or describe a blue circle?",
    correctAnswer: false,
  },
  {
    text: "Does the output contain or describe a red rectangle?",
    correctAnswer: true,
  },
];
type Snapshot = {
  id: string;
  status: string;
  input: GridInput;
  spentUsd: number;
  cells: (Cell & { outputReady: boolean })[];
};

async function connect(page: Page, format: GridInput["format"]) {
  const key = process.env.OPENROUTER_API_KEY;
  expect(
    key,
    "Real judging requires OPENROUTER_API_KEY with paid credit and access to the required models.",
  ).toBeTruthy();
  await page.goto("/create");
  await page.getByRole("button", { name: "Use API key", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill(key!);
  await page
    .getByRole("button", { name: "Connect API key", exact: true })
    .click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const headers = {
    authorization: `Bearer ${key}`,
    origin: new URL(page.url()).origin,
  };
  const capacityResponse = await page.request.get(
    `/api/inference-capacity?format=${format}`,
    { headers },
  );
  expect(
    capacityResponse.ok(),
    "Could not check real OpenRouter balance.",
  ).toBe(true);
  const capacity = await capacityResponse.json();
  expect(
    typeof capacity.balanceUsd,
    "A verifiable OpenRouter balance is required; unknown balance is not accepted.",
  ).toBe("number");
  expect(
    capacity.balanceUsd,
    "Real judging requires at least $1 of available OpenRouter credit/key allowance.",
  ).toBeGreaterThanOrEqual(1);
  const catalogResponse = await page.request.get("/api/models");
  expect(
    catalogResponse.ok(),
    "OpenRouter model catalog must be available.",
  ).toBe(true);
  const models: Model[] = await catalogResponse.json();
  for (const id of judges) {
    const model = models.find((entry) => entry.id === id);
    expect(model, `Required judge model is unavailable: ${id}`).toBeTruthy();
    expect(model!.text, `${id} must support text output.`).toBe(true);
    expect(model!.reasoning, `${id} must support thinking effort.`).toBe(true);
    expect(
      model!.structuredOutputs,
      `${id} must support strict structured outputs.`,
    ).toBe(true);
    expect(
      model!.imageInput,
      `${id} must accept image inputs for image/SVG judging.`,
    ).toBe(true);
  }
  if (format === "image") {
    expect(
      models.find((entry) => entry.id === imageGenerator)?.image,
      `Required image generator is unavailable: ${imageGenerator}`,
    ).toBe(true);
  }
  return headers;
}

async function create(
  page: Page,
  input: GridInput,
  headers: Record<string, string>,
  reuse?: string,
) {
  const response = await page.request.post("/api/grids", {
    headers,
    data: {
      ...input,
      ...(reuse ? { sourceGridId: reuse, reuseArtifacts: true } : {}),
    },
  });
  expect(
    response.status(),
    `Real grid creation failed: ${await response.text()}`,
  ).toBe(201);
  const { id } = await response.json();
  await page.goto(`/grid/${id}`);
  let grid: Snapshot;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/grids/${id}`);
        expect(response.ok()).toBe(true);
        grid = await response.json();
        const errors = grid.cells.filter((cell) => cell.status === "error");
        expect(
          errors.map((cell) => ({ error: cell.error, judge: cell.judge })),
          "Real provider generation/judging failed; no model fallback or skip is permitted.",
        ).toEqual([]);
        expect(
          grid.status,
          "Real inference paused: check credit, credentials, and model availability.",
        ).not.toBe("paused");
        return grid.cells.every((cell) => cell.status === "complete");
      },
      { timeout: 240_000, intervals: [1000, 2000, 5000] },
    )
    .toBe(true);
  return grid!;
}

async function inspect(page: Page, grid: Snapshot) {
  expect(new Set(grid.cells.map((cell) => cell.generationId)).size).toBe(1);
  const outputs: Buffer[] = [];
  const expected = grid.input.judge!.criteria;
  const scores = page.locator(".judge-result-button");
  await expect(scores).toHaveCount(grid.cells.length);
  for (const [index, cell] of grid.cells.entries()) {
    expect(cell.outputReady).toBe(true);
    expect(cell.judge?.status).toBe("complete");
    expect(cell.judge?.results).toHaveLength(expected.length);
    const correct = cell.judge!.results!.filter(
      (result, criterion) =>
        result.verdict === expected[criterion].correctAnswer,
    ).length;
    await expect(scores.nth(index)).toHaveText(`${correct}/${expected.length}`);
    await expect(scores.nth(index)).toHaveAccessibleName(
      `Judgment: ${correct} of ${expected.length} correct`,
    );
    const download = await page.request.get(`/outputs/${cell.id}/download`);
    expect(download.ok()).toBe(true);
    outputs.push(await download.body());
  }
  for (const output of outputs.slice(1))
    expect(output.equals(outputs[0])).toBe(true);
  const cell = page.locator(".cell").first();
  const details = cell.getByRole("region", {
    name: "Judgment details",
    exact: true,
  });
  await expect(scores.first()).toHaveAttribute("aria-pressed", "true");
  await expect(details).toBeVisible();
  await expect(cell.locator(".cell-view").first()).toBeVisible();
  const items = details.getByRole("listitem");
  for (const [index, result] of grid.cells[0].judge!.results!.entries()) {
    const matched = result.verdict === expected[index].correctAnswer;
    await expect(
      items.nth(index).getByRole("img", {
        name: matched ? "Correct" : "Incorrect",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      items.nth(index).getByText(result.explanation, { exact: true }),
    ).toBeVisible();
  }
  await expect(details.getByText(/^(Correct|Incorrect)$/)).toHaveCount(0);
  await scores.first().click();
  await expect(details).toBeHidden();
  await expect(scores.first()).toHaveAttribute("aria-pressed", "false");
  const links = page.getByRole("link", { name: "Open output", exact: true });
  await expect(links).toHaveCount(grid.cells.length);
  for (const link of await links.all()) {
    const response = await page.request.get((await link.getAttribute("href"))!);
    expect(response.ok()).toBe(true);
  }
}

async function billing(page: Page, grid: Snapshot, generationCount: number) {
  const response = await page.request.get("/api/billing");
  expect(response.ok()).toBe(true);
  const bill: BillingPage = await response.json();
  const calls = bill.calls.filter((call) => call.gridId === grid.id);
  const judgments = calls.filter((call) => call.phase === "judge");
  const generation = calls.filter((call) => call.phase !== "judge");
  expect(judgments).toHaveLength(grid.cells.length);
  expect(generation).toHaveLength(generationCount);
  for (const call of calls) {
    expect(call.status, call.error).toBe("succeeded");
    expect(
      call.usage?.costUsd,
      "Actual paid provider charges must be recorded.",
    ).toBeGreaterThan(0);
  }
  expect(
    new Set(judgments.map((call) => `${call.model}/${call.effort}`)),
  ).toEqual(
    new Set(
      grid.cells.map((cell) => `${cell.judge!.model}/${cell.judge!.effort}`),
    ),
  );
  const generationCost = generation.reduce(
    (sum, call) => sum + call.usage!.costUsd!,
    0,
  );
  expect(grid.spentUsd).toBeCloseTo(generationCost, 10);
  if (generationCount) {
    for (const cell of grid.cells)
      expect(cell.usage).toEqual(generation[0].usage);
  }
  expect(bill.costUsd).toBeCloseTo(
    bill.calls.reduce((sum, call) => sum + (call.usage?.costUsd ?? 0), 0),
    10,
  );
  await page.reload();
  const reloaded: Snapshot = await (
    await page.request.get(`/api/grids/${grid.id}`)
  ).json();
  expect(reloaded.spentUsd).toBe(grid.spentUsd);
  expect(reloaded.cells.map((cell) => cell.usage)).toEqual(
    grid.cells.map((cell) => cell.usage),
  );
  await page.goto("/billing");
  await expect(
    page.getByRole("cell", { name: "Judge", exact: true }),
  ).toHaveCount(bill.calls.filter((call) => call.phase === "judge").length);
}

for (const format of ["markdown", "chat-template", "image", "svg"] as const) {
  test(`real ${format} judgments use committed artifacts and isolated billing`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const headers = await connect(page, format);
    const prompt =
      format === "svg"
        ? "Return only a valid SVG: a solid red rectangle on a white 64 by 64 canvas. No circles, text, gradients or external resources."
        : format === "image"
          ? "A single solid red rectangle centered on a plain white background. Flat geometric diagram. No circles, letters, or other objects."
          : "Respond with only this short sentence: A red rectangle is shown.";
    const input: GridInput = {
      format,
      prompt,
      model: format === "image" ? imageGenerator : textGenerator,
      effort: "default",
      budgetUsd: 0.03,
      ...(format === "chat-template"
        ? {
            messages: [
              { role: "user" as const, content: prompt },
              { role: "unfilled" as const, content: "" },
            ],
          }
        : {}),
      rows:
        format === "svg" || format === "chat-template"
          ? { kind: "model", values: [textGenerator] }
          : {
              kind: "judge_model",
              values: format === "markdown" ? judges : [judges[0]],
            },
      columns:
        format === "svg" || format === "chat-template"
          ? { kind: "effort", values: ["default"] }
          : {
              kind: "judge_effort",
              values: format === "markdown" ? ["low", "high"] : ["low"],
            },
      judge: {
        criteria,
        model: format === "svg" || format === "chat-template" ? judges[0] : "",
        effort: "low",
      },
    };
    const grid = await create(page, input, headers);
    expect(new Set(grid.cells.map((cell) => cell.judge!.effort))).toEqual(
      new Set(format === "markdown" ? ["low", "high"] : ["low"]),
    );
    await inspect(page, grid);
    await billing(page, grid, 1);
    if (format === "markdown") {
      const fresh = await create(
        page,
        {
          ...input,
          judge: {
            ...input.judge!,
            criteria: [criteria[0], { ...criteria[1], correctAnswer: false }],
          },
        },
        headers,
        grid.id,
      );
      await inspect(page, fresh);
      const firstAttempts = new Set(
        grid.cells.map((cell) => cell.judge!.attemptId),
      );
      for (const cell of fresh.cells)
        expect(firstAttempts.has(cell.judge!.attemptId)).toBe(false);
      await billing(page, fresh, 0);
    }
  });
}
