import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";
import { connectOpenRouter } from "./helpers";
import { currentInput } from "../current-grid-fixture";
export async function acceptDrop(page: Page, action: () => Promise<unknown>) {
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await action();
}

type JudgmentScrollGeometry = {
  limit: number;
  height: number;
  scale: number;
  edges: number[];
};

export function expectJudgmentFocus(
  source: JudgmentScrollGeometry & { position: number },
  target: JudgmentScrollGeometry & { position: number },
  criterion: number,
  focusFraction: number,
) {
  const start = criterion * 2;
  const fraction =
    (source.position + source.height * focusFraction - source.edges[start]) /
    (source.edges[start + 1] - source.edges[start]);
  const offset =
    target.edges[start] +
    (target.edges[start + 1] - target.edges[start]) * fraction -
    target.position -
    target.height * focusFraction;
  expect(target.position).toBeGreaterThanOrEqual(0);
  expect(target.position).toBeLessThanOrEqual(target.limit);
  if (target.position < 2) expect(offset).toBeLessThanOrEqual(2);
  else if (target.position > target.limit - 2)
    expect(offset).toBeGreaterThanOrEqual(-2);
  else expect(Math.abs(offset)).toBeLessThan(2);
}

export function expectJudgmentAlignment(
  views: (JudgmentScrollGeometry & { position: number })[],
  leader: number,
  focusFraction: number,
) {
  const source = views[leader];
  const point = source.position + source.height * focusFraction;
  const start = source.edges.findIndex(
    (edge, index) =>
      index % 2 === 0 && edge <= point && source.edges[index + 1] >= point,
  );
  expect(
    start,
    "the persistent focus lies inside a rendered criterion",
  ).toBeGreaterThanOrEqual(0);
  expectJudgmentFocus(source, views[1 - leader], start / 2, focusFraction);
}
export const judgedCriteria = [
  { text: "Is there a blue circle?", correctAnswer: false },
  { text: "Is there a red rectangle?", correctAnswer: true },
];
export const judgedInput = currentInput({
  format: "markdown",
  budgetUsd: 0.1,
  judge: true,
  parameters: {
    input: {
      kind: "common",
      value: [{ role: "user", content: "Describe a red rectangle" }],
    },
    effort: { kind: "common", value: "none" },
    judge_model: { kind: "rows" },
    judge_effort: { kind: "columns" },
    judge_criteria: { kind: "common", value: judgedCriteria },
  },
  rows: [{ judge_model: "fixture/text" }, { judge_model: "fixture/other" }],
  columns: [{ judge_effort: "none" }, { judge_effort: "high" }],
});

export async function selectJudgeResults(page: Page) {
  const button = page
    .getByRole("group", { name: "Grid view", exact: true })
    .getByRole("button", { name: "Judge results", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

export async function createJudged(page: Page, input: GridInput = judgedInput) {
  await page.goto("/create");
  await connectOpenRouter(page);
  const response = await page.request.post("/api/grids", {
    headers: { origin: new URL(page.url()).origin },
    data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.goto(`/grid/${grid.id}`);
  return grid.id as string;
}

export async function seedJudged(page: Page, input: GridInput = judgedInput) {
  await page.request.get("/api/grids");
  const response = await page.request.post("/fixture/completed-judgment", {
    data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.goto(`/grid/${grid.id}`);
  return grid.id as string;
}
