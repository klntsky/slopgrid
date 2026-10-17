import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { GridInput } from "../../server/domain";

test("judge criteria preserve boolean answers and judge axes restore fixed settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("button", { name: "[ add a judge ]", exact: true }).click();
  await page.getByLabel("Criterion 1", { exact: true }).fill("Is there a blue circle?");
  await page.getByLabel("Correct answer", { exact: true }).selectOption("false");
  await page.reload();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("Is there a blue circle?");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue("false");
  await page.getByRole("button", { name: "Add criterion", exact: true }).click();
  await expect(page.getByLabel("Correct answer", { exact: true }).nth(1)).toHaveValue("true");
  await page.getByRole("button", { name: "Remove criterion 2", exact: true }).click();
  await page.getByRole("button", { name: "Remove criterion 1", exact: true }).click();
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveValue("true");
  await page.getByRole("combobox", { name: "Rows", exact: true }).selectOption("judge_effort");
  await page.getByRole("combobox", { name: "Columns", exact: true }).selectOption("judge_model");
  await expect(page.getByRole("searchbox", { name: "Search judge models" })).toBeVisible();
  await page.getByRole("button", { name: "Swap rows and columns", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Rows", exact: true })).toHaveValue("judge_model");
  await expect(page.getByRole("combobox", { name: "Columns", exact: true })).toHaveValue("judge_effort");
  await page.getByRole("button", { name: "Remove judge", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Rows", exact: true })).toHaveValue("effort");
  await expect(page.getByRole("combobox", { name: "Columns", exact: true })).toHaveValue("model");
  await expect(page.getByRole("button", { name: "[ add a judge ]", exact: true })).toBeVisible();
});

const judgedInput: GridInput = {
  format: "markdown", prompt: "Describe a red rectangle", model: "fixture/text", effort: "none", budgetUsd: 0.1,
  rows: { kind: "judge_model", values: ["fixture/text", "fixture/other"] },
  columns: { kind: "judge_effort", values: ["none", "high"] },
  judge: { criteria: [
    { text: "Is there a blue circle?", correctAnswer: false },
    { text: "Is there a red rectangle?", correctAnswer: true },
  ], model: "", effort: "default" },
};

async function createJudged(page: Page, input: GridInput = judgedInput) {
  await page.goto("/create");
  await page.getByRole("link", { name: "Connect OpenRouter", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const response = await page.request.post("/api/grids", {
    headers: { origin: new URL(page.url()).origin }, data: input,
  });
  expect(response.status()).toBe(201);
  const grid = await response.json();
  await page.goto(`/grid/${grid.id}`);
  return grid.id as string;
}

test("shared generation stays usable while judging; the scales popup scores expected answers and works expanded", async ({ page }) => {
  await page.request.post("/fixture/reset", { data: {
    holdJudges: true, textCost: 0.1,
    judgeOutput: JSON.stringify({ results: [
      { verdict: false, explanation: "No blue circle." },
      { verdict: false, explanation: "No red rectangle." },
    ] }),
  } });
  const id = await createJudged(page);
  const scores = page.locator(".judge-result-button");
  await expect(scores).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Download output", exact: true })).toHaveCount(4);
  await expect(scores).toHaveText(["-/2", "-/2", "-/2", "-/2"]);
  await expect(page.getByLabel("Total cost: $0.10", { exact: true })).toBeVisible();
  await scores.first().click();
  const popup = page.getByRole("dialog", { name: "Judged output", exact: true });
  await expect(popup).toBeVisible();
  await expect(popup.getByText("Correct", { exact: true })).toHaveCount(0);
  await expect(popup.getByText("Incorrect", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(scores.first()).toBeFocused();
  await page.request.post("/fixture/release", { data: { all: true } });
  const completed = page.getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true });
  await expect(completed).toHaveCount(4);
  await expect(completed).toHaveText(["1/2", "1/2", "1/2", "1/2"]);
  await expect(page.getByText("No blue circle.", { exact: true })).not.toBeVisible();
  await completed.first().focus();
  await page.keyboard.press("Enter");
  const items = popup.getByRole("listitem");
  await expect(items.nth(0).getByText("Correct", { exact: true })).toBeVisible();
  await expect(items.nth(1).getByText("Incorrect", { exact: true })).toBeVisible();
  await expect(items.nth(0).getByText("No blue circle.", { exact: true })).toBeVisible();
  await expect(items.nth(1).getByText("No red rectangle.", { exact: true })).toBeVisible();
  expect(await items.nth(0).getByText("Correct", { exact: true }).evaluate((element) => getComputedStyle(element).color))
    .not.toBe(await items.nth(1).getByText("Incorrect", { exact: true }).evaluate((element) => getComputedStyle(element).color));
  await popup.getByRole("button", { name: "Close judgment", exact: true }).click();
  await expect(completed.first()).toBeFocused();
  await completed.first().click();
  await page.getByRole("heading", { level: 1, name: judgedInput.prompt, exact: true }).click();
  await expect(popup).not.toBeVisible();
  await page.locator(".cell").first().getByRole("button", { name: "Expand Markdown", exact: true }).click();
  const expanded = page.getByRole("region", { name: /^Expanded output:/ });
  await expect(expanded.getByRole("link", { name: "Download output", exact: true })).toBeVisible();
  await expanded.getByRole("button", { name: "Judgment: 1 of 2 correct", exact: true }).click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect(grid.cells.map((cell: { usage: unknown }) => cell.usage)).toEqual(Array(4).fill({ inputTokens: 10, outputTokens: 20, costUsd: 0.1 }));
  expect(grid.spentUsd).toBe(0.1);
  expect((await (await page.request.get("/fixture/calls")).json()).length).toBe(5);
  expect((await (await page.request.get("/fixture/judge-requests")).json()).length).toBe(4);
});

test("failed judging shows unresolved criteria without hiding generation or its downloads", async ({ page }) => {
  await page.request.post("/fixture/reset", { data: { judgeOutput: '{"results":[]}', textCost: 0.1 } });
  const id = await createJudged(page, {
    ...judgedInput, rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["high"] },
  });
  const score = page.getByRole("button", { name: /^Judging failed:/ });
  await expect(score).toHaveText("-/2");
  await expect(page.getByRole("link", { name: "Download output", exact: true })).toBeVisible();
  const grid = await (await page.request.get(`/api/grids/${id}`)).json();
  expect((await page.request.get(`/outputs/${grid.cells[0].id}/download`)).status()).toBe(200);
  await score.click();
  const popup = page.getByRole("dialog", { name: "Judged output", exact: true });
  await expect(popup.getByRole("status")).toContainText("Judging failed:");
  await expect(popup.getByText("Correct", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByLabel("Total cost: $0.10", { exact: true })).toBeVisible();
  await expect(score).toHaveText("-/2");
  await page.goto("/billing");
  await expect(page.getByRole("cell", { name: "Judge", exact: true })).toHaveCount(1);
  const billing = await (await page.request.get("/api/billing")).json();
  expect(billing.calls.find((call: { phase: string }) => call.phase === "judge").usage.costUsd).toBe(0.25);
  expect(billing.costUsd).toBe(0.35);
});

test("closing the page during judging does not stop completed judgments", async ({ page, context }) => {
  await page.request.post("/fixture/reset", { data: { holdJudges: true } });
  const id = await createJudged(page, {
    ...judgedInput, rows: { kind: "judge_model", values: ["fixture/text"] },
    columns: { kind: "judge_effort", values: ["none"] },
  });
  await expect(page.getByRole("button", { name: "Judging...", exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.close();
  await context.request.post(`${origin}/fixture/release`, { data: { all: true } });
  const reopened = await context.newPage();
  await reopened.goto(`${origin}/grid/${id}`);
  await expect(reopened.getByRole("button", { name: "Judgment: 2 of 2 correct", exact: true })).toHaveText("2/2");
  expect((await (await context.request.get(`${origin}/fixture/calls`)).json()).length).toBe(2);
});
