import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  connectOpenRouter,
  expectProgress,
  finishPublishing,
  selectModel,
  setVariableValues,
} from "./helpers";

const rubric = (page: Page, side: "Row" | "Column", index: number) =>
  page.locator(`[aria-label="${side} case ${index} judge criteria"]`);

async function confirm(
  page: Page,
  accept: boolean,
  action: () => Promise<unknown>,
) {
  page.once("dialog", async (dialog) => {
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await action();
}

async function start(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Add a LLM judge", exact: true })
    .check();
  await page
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the output answer the question?");
}

async function selectJudge(page: Page) {
  const selector = page.getByRole("radiogroup", {
    name: "Judge model",
    exact: true,
  });
  await selector.getByRole("searchbox").fill("fixture/text");
  await selector.locator('input[type="radio"][value="fixture/text"]').check();
}

function requestText(call: {
  messages: { content: string | { text?: string }[] }[];
}) {
  return call.messages
    .map(({ content }) =>
      typeof content === "string"
        ? content
        : content.map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

async function generate(page: Page) {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/grids",
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await expect(page).toHaveURL(new RegExp(`/grid/${id}$`));
  return id as string;
}

test("judge conversion is confirmed, single-source and reversible from a chosen case", async ({
  page,
}) => {
  await start(page);
  const rowButton = page.getByRole("button", {
    name: "Make the judge a row variable",
    exact: true,
  });
  const columnButton = page.getByRole("button", {
    name: "Make the judge a column variable",
    exact: true,
  });
  await expect(rowButton).toBeDisabled();
  await expect(columnButton).toBeDisabled();
  await rowButton.locator("..").hover();
  await expect(page.getByRole("tooltip")).toContainText(/row/i);
  await expect(page.getByRole("tooltip")).toContainText(/variable/i);
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["Alpha", "Beta"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Columns", ["Context"]);
  await expect(rowButton).toBeEnabled();
  await expect(columnButton).toBeEnabled();
  await confirm(page, false, () => rowButton.click());
  await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
    "Does the output answer the question?",
  );
  await expect(rubric(page, "Row", 1)).toHaveCount(0);
  await confirm(page, true, () => rowButton.click());
  await expect(
    rubric(page, "Row", 1).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toBeDisabled();
  await expect(columnButton).toHaveCount(0);
  await rubric(page, "Row", 1)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the output satisfy alpha?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 1", { exact: true }),
  ).toHaveValue("Does the output answer the question?");
  await rubric(page, "Row", 2)
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the output contain a blue circle?");
  await rubric(page, "Row", 2)
    .getByLabel("Correct answer", { exact: true })
    .nth(1)
    .click();
  const makeShared = rubric(page, "Row", 2).getByRole("button", {
    name: "Use this judge for all cases",
    exact: true,
  });
  await confirm(page, false, () => makeShared.click());
  await expect(rubric(page, "Row", 1)).toBeVisible();
  await confirm(page, true, () => makeShared.click());
  await expect(rubric(page, "Row", 1)).toHaveCount(0);
  await expect(page.getByLabel("Criterion 2", { exact: true })).toHaveValue(
    "Does the output contain a blue circle?",
  );
  await expect(
    page.getByLabel("Correct answer", { exact: true }).nth(1),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(rowButton).toBeEnabled();
  await expect(columnButton).toBeEnabled();
  await confirm(page, true, () => columnButton.click());
  await expect(
    rubric(page, "Column", 1).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the output contain a blue circle?");
  await expect(
    rubric(page, "Column", 1)
      .getByLabel("Correct answer", { exact: true })
      .nth(1),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Swap rows and columns", exact: true })
    .click();
  await page.reload();
  await expect(
    rubric(page, "Row", 1).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the output contain a blue circle?");
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toBeEnabled();
});

test("different case rubrics judge one reused generation independently and survive Edit and Fork", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", {
    data: { markdownOutput: "A useful answer." },
  });
  await start(page);
  await page
    .getByRole("combobox", { name: "Rows", exact: true })
    .selectOption("variable");
  await setVariableValues(page, "Rows", ["Alpha reference", "Beta reference"]);
  await page
    .getByRole("combobox", { name: "Columns", exact: true })
    .selectOption("effort");
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Answer independently of judge-only reference material.");
  await confirm(page, true, () =>
    page
      .getByRole("button", {
        name: "Make the judge a row variable",
        exact: true,
      })
      .click(),
  );
  await rubric(page, "Row", 1)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer match $ROW1?");
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 1", { exact: true })
    .fill("Does the answer contain a blue circle?");
  await rubric(page, "Row", 2)
    .getByLabel("Correct answer", { exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the answer respect $ROW1?");
  await selectModel(page, "fixture/text");
  await selectJudge(page);
  await connectOpenRouter(page);
  const originalId = await generate(page);
  await expectProgress(page, 2, 2);
  await expect(
    page.getByRole("button", { name: "Judgment: 1 of 1 correct", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Judgment: 2 of 2 correct", exact: true }),
  ).toBeVisible();
  const generation = await (await request.get("/fixture/chat-requests")).json();
  expect(generation).toHaveLength(1);
  expect(requestText(generation[0])).not.toContain("Alpha reference");
  expect(requestText(generation[0])).not.toContain("Beta reference");
  const judgments = (
    await (await request.get("/fixture/judge-requests")).json()
  ).map(requestText);
  expect(judgments).toHaveLength(2);
  expect(judgments).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Does the answer match Alpha reference?"),
      expect.stringContaining("Does the answer respect Beta reference?"),
    ]),
  );
  const judgmentButton = page.getByRole("button", {
    name: "Judgment: 2 of 2 correct",
    exact: true,
  });
  if ((await judgmentButton.getAttribute("aria-pressed")) !== "true")
    await judgmentButton.click();
  const details = judgmentButton
    .locator("xpath=ancestor::td[1]")
    .getByRole("region", { name: "Judgment details", exact: true });
  await expect(details.getByRole("listitem")).toHaveCount(2);
  await expect(
    details.getByText("not(Does the answer contain a blue circle?)", {
      exact: true,
    }),
  ).toBeVisible();
  const original = await (
    await page.request.get(`/api/grids/${originalId}`)
  ).json();
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the answer respect $ROW1?");
  await rubric(page, "Row", 2)
    .getByLabel("Criterion 2", { exact: true })
    .fill("Does the answer agree with $ROW1?");
  await page
    .getByRole("checkbox", {
      name: "Reuse existing artifacts from the previous version",
      exact: true,
    })
    .check();
  await request.post("/fixture/reset", {
    data: { markdownOutput: "Must not regenerate." },
  });
  const revisedId = await generate(page);
  await expectProgress(page, 2, 2);
  expect(await (await request.get("/fixture/chat-requests")).json()).toEqual(
    [],
  );
  const revised = await (
    await page.request.get(`/api/grids/${revisedId}`)
  ).json();
  expect(
    revised.cells.map((cell: { artifactId: string }) => cell.artifactId),
  ).toEqual(
    original.cells.map((cell: { artifactId: string }) => cell.artifactId),
  );
  const revisedJudgments = (
    await (await request.get("/fixture/judge-requests")).json()
  ).map(requestText);
  expect(revisedJudgments).toHaveLength(2);
  expect(revisedJudgments).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Does the answer agree with Beta reference?"),
    ]),
  );
  await page.getByRole("button", { name: "PUBLISH", exact: true }).click();
  await finishPublishing(page);
  await page.getByRole("button", { name: "FORK", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await page.reload();
  await expect(
    rubric(page, "Row", 2).getByLabel("Criterion 2", { exact: true }),
  ).toHaveValue("Does the answer agree with $ROW1?");
  await expect(
    rubric(page, "Row", 2).getByLabel("Correct answer", { exact: true }).nth(0),
  ).toHaveAttribute("aria-pressed", "false");
});
