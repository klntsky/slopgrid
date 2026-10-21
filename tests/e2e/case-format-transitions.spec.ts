import type { Dialog, Page } from "@playwright/test";
import type { Draft } from "../../src/create/draft";
import { defaultGridDraft } from "../../server/parameters";
import { test, expect } from "./fixtures";
import { mockModels } from "./helpers";

const commonImage = { id: "common-reference", name: "common.png" };
const caseImage = { id: "case-reference", name: "case.png" };

async function savedDraft(page: Page): Promise<Draft> {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("slopgrid-draft")!),
  );
}

async function openDraft(page: Page, draft: Draft) {
  await page.goto("/create");
  await page.evaluate((value) => {
    sessionStorage.setItem("slopgrid-draft", JSON.stringify(value));
  }, draft);
  await page.reload();
  await expect.poll(() => savedDraft(page)).toEqual(draft);
}

async function changeFormat(page: Page, name: string, accept = true) {
  const messages: string[] = [];
  const handleDialog = async (dialog: Dialog) => {
    messages.push(dialog.message());
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  };
  page.on("dialog", handleDialog);
  await page.getByRole("button", { name, exact: true }).click();
  page.off("dialog", handleDialog);
  return messages;
}

function caseDraft(): Draft {
  return {
    formatSelected: true,
    sourceGridId: "source-grid",
    reuseArtifacts: true,
    input: {
      ...defaultGridDraft("svg"),
      prompt: "Draw $ROW1 with $ROW3",
      promptImages: [commonImage],
      budgetUsd: "0.75",
      judge: true,
      parameters: {
        variable: { kind: "rows" },
        model: { kind: "rows" },
        effort: { kind: "rows" },
        judge_criteria: { kind: "rows" },
        judge_effort: { kind: "rows" },
        judge_model: { kind: "columns" },
      },
      rows: [
        {
          id: "second-case-first",
          variable: [
            { text: "Blue", images: [caseImage] },
            null,
            { text: "square" },
          ],
          model: "fixture/other",
          effort: "high",
          judge_effort: "low",
          judge_criteria: [{ text: "Is $ROW1 visible?", correctAnswer: true }],
        },
        {
          id: "first-case-second",
          variable: [
            { text: "Red" },
            null,
            { text: "circle", images: [caseImage] },
          ],
          model: "fixture/text",
          effort: "low",
          judge_effort: "high",
          judge_criteria: [{ text: "Is it green?", correctAnswer: false }],
        },
      ],
      columns: [{ id: "judge-column", judge_model: "fixture/text" }],
    },
  };
}

test("SVG and Markdown retain ordered case fields, tombstones, images and correlated settings", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  expect(await changeFormat(page, "Markdown")).toEqual([]);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: { ...draft.input, format: "markdown" },
    });
  await expect(page.getByLabel("$ROW3, case 2", { exact: true })).toHaveValue(
    "circle",
  );
  await expect(page.getByLabel("$ROW2, case 1", { exact: true })).toHaveCount(
    0,
  );
  expect(await changeFormat(page, "SVG")).toEqual([]);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  await page.reload();
  await expect.poll(() => savedDraft(page)).toEqual(draft);
});

test("ordinary native axes retain their owners, values and IDs without a case table", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("svg"),
      prompt: "An ordinary prompt",
      rows: [
        { id: "model-b", model: "fixture/other" },
        { id: "model-a", model: "fixture/text" },
      ],
      columns: [
        { id: "effort-high", effort: "high" },
        { id: "effort-low", effort: "low" },
      ],
    },
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "Markdown")).toEqual([]);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: { ...draft.input, format: "markdown" },
    });
  await expect(
    page.getByRole("combobox", { name: "Rows", exact: true }),
  ).toHaveValue("model");
  await expect(
    page.getByRole("combobox", { name: "Columns", exact: true }),
  ).toHaveValue("effort");
  await expect(
    page.getByRole("table", { name: "Grid layout parameters", exact: true }),
  ).toHaveCount(0);
});

test("image-only common and case settings require one confirmation and cancellation is atomic", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    sourceGridId: "image-source",
    reuseArtifacts: true,
    input: {
      ...defaultGridDraft("image"),
      prompt: "Draw $ROW1",
      promptImages: [commonImage],
      parameters: {
        variable: { kind: "rows" },
        model: { kind: "rows" },
        quality: { kind: "rows" },
        size: { kind: "common", value: "1536x1024" },
        aspect_ratio: { kind: "common", value: "16:9" },
        background: { kind: "common", value: "transparent" },
      },
      rows: [
        {
          id: "image-b",
          variable: [{ text: "Blue", images: [caseImage] }, null],
          model: "fixture/image",
          quality: "high",
        },
        {
          id: "image-a",
          variable: [{ text: "Red" }, null],
          model: "fixture/image",
          quality: "low",
        },
      ],
      columns: [{ id: "neutral-column" }],
    },
  };
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Markdown", false);
  expect(rejected).toHaveLength(1);
  for (const name of ["Model", "Quality", "Size", "Aspect ratio", "Background"])
    expect(rejected[0]).toContain(name);
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Markdown")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "markdown",
        parameters: {
          variable: { kind: "rows" },
          model: { kind: "rows" },
          effort: { kind: "common", value: "default" },
        },
        rows: draft.input.rows.map(({ quality: _quality, ...entry }) => ({
          ...entry,
          model: "",
        })),
      },
    });
});

test("generator effort is discarded only after confirmation when switching to Image", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Image", false);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toContain("Thinking effort");
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Image")).toHaveLength(1);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("image");
  const changed = await savedDraft(page);
  expect(changed.input.parameters.effort).toBeUndefined();
  expect(changed.input.rows.map(({ effort }) => effort)).toEqual([
    undefined,
    undefined,
  ]);
  expect(changed.input.rows.map(({ variable }) => variable)).toEqual(
    draft.input.rows.map(({ variable }) => variable),
  );
  expect(
    changed.input.rows.map(({ judge_criteria }) => judge_criteria),
  ).toEqual(draft.input.rows.map(({ judge_criteria }) => judge_criteria));
  expect(changed.input.parameters.judge_model).toEqual(
    draft.input.parameters.judge_model,
  );
  expect(changed.input.columns).toEqual(draft.input.columns);
  expect(changed.input.promptImages).toEqual([commonImage]);
});

test("Website removes all judging fields only after a single accepted loss confirmation", async ({
  page,
}) => {
  const draft = caseDraft();
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "Static website", false);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toContain("Judge criteria");
  expect(rejected[0]).toContain("Judge model");
  expect(rejected[0]).toContain("Judge thinking effort");
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "Static website")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "html",
        judge: false,
        parameters: {
          variable: { kind: "rows" },
          model: { kind: "rows" },
          effort: { kind: "rows" },
        },
        rows: draft.input.rows.map(
          ({ judge_criteria: _criteria, judge_effort: _effort, ...entry }) =>
            entry,
        ),
        columns: [{ id: "judge-column" }],
      },
    });
});

for (const differing of [false, true]) {
  test(`ordinary criteria collapse ${differing ? "drops differing values after confirmation" : "preserves equal values without confirmation"}`, async ({
    page,
  }) => {
    const criteria = [{ text: "Does the answer fit?", correctAnswer: false }];
    const draft: Draft = {
      formatSelected: true,
      input: {
        ...defaultGridDraft("svg"),
        judge: true,
        parameters: {
          model: { kind: "rows" },
          effort: { kind: "columns" },
          judge_model: { kind: "common", value: "fixture/text" },
          judge_effort: { kind: "common", value: "high" },
          judge_criteria: { kind: "rows" },
        },
        rows: [
          { id: "model-a", model: "fixture/text", judge_criteria: criteria },
          {
            id: "model-b",
            model: "fixture/other",
            judge_criteria: differing
              ? [{ text: "A different rubric", correctAnswer: true }]
              : criteria,
          },
        ],
        columns: [{ id: "effort-column", effort: "low" }],
      },
    };
    await openDraft(page, draft);
    if (differing) {
      expect(await changeFormat(page, "Markdown", false)).toHaveLength(1);
      await expect.poll(() => savedDraft(page)).toEqual(draft);
    }
    expect(await changeFormat(page, "Markdown")).toHaveLength(
      differing ? 1 : 0,
    );
    await expect
      .poll(() => savedDraft(page))
      .toEqual({
        ...draft,
        input: {
          ...draft.input,
          format: "markdown",
          parameters: {
            ...draft.input.parameters,
            judge_criteria: {
              kind: "common",
              value: differing ? [{ text: "", correctAnswer: true }] : criteria,
            },
          },
          rows: draft.input.rows.map(
            ({ judge_criteria: _criteria, ...entry }) => entry,
          ),
        },
      });
  });
}

test("removing the last ordinary owner creates one neutral position without moving common settings", async ({
  page,
}) => {
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("image"),
      parameters: {
        ...defaultGridDraft("image").parameters,
        model: { kind: "rows" },
      },
      rows: [{ id: "image-model", model: "fixture/image" }],
      columns: [
        { id: "quality-first", quality: "high" },
        { id: "quality-second", quality: "low" },
      ],
    },
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "SVG")).toHaveLength(1);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("svg");
  const changed = await savedDraft(page);
  expect(changed.input.parameters).toEqual({
    model: { kind: "rows" },
    effort: { kind: "common", value: "default" },
  });
  expect(changed.input.columns).toEqual([{ id: "quality-first" }]);
  expect(changed.input.rows).toEqual([{ id: "image-model", model: "" }]);
});

test("an incompatible case judge model requires confirmation without discarding its case rubric", async ({
  page,
}) => {
  await mockModels(page, (models) =>
    models.map((model) =>
      model.id === "fixture/other" ? { ...model, imageInput: false } : model,
    ),
  );
  const draft = caseDraft();
  draft.input.format = "markdown";
  draft.input.columns = [{ id: "judge-column", judge_model: "fixture/other" }];
  await openDraft(page, draft);
  const rejected = await changeFormat(page, "SVG", false);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toContain("Judge model");
  await expect.poll(() => savedDraft(page)).toEqual(draft);
  expect(await changeFormat(page, "SVG")).toHaveLength(1);
  await expect
    .poll(() => savedDraft(page))
    .toEqual({
      ...draft,
      input: {
        ...draft.input,
        format: "svg",
        columns: [{ id: "judge-column", judge_model: "" }],
      },
    });
});

test("common prompt images stay separate from Chat message images and unknown models survive", async ({
  page,
}) => {
  await mockModels(page, () => []);
  const draft: Draft = {
    formatSelected: true,
    input: {
      ...defaultGridDraft("markdown"),
      prompt: "A prompt",
      promptImages: [commonImage],
      parameters: {
        model: { kind: "common", value: "unloaded/model" },
        effort: { kind: "common", value: "high" },
      },
      rows: [{ id: "neutral-row" }],
      columns: [{ id: "neutral-column" }],
    },
    inactiveChatMessages: [
      { role: "user", content: "A separate chat", images: [caseImage] },
    ],
  };
  await openDraft(page, draft);
  expect(await changeFormat(page, "Chat completion")).toEqual([]);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("chat-template");
  const chat = await savedDraft(page);
  expect(chat.input.promptImages).toEqual([]);
  expect(chat.input.messages).toEqual(draft.inactiveChatMessages);
  expect(chat.inactivePromptImages).toEqual([commonImage]);
  expect(chat.input.parameters).toEqual(draft.input.parameters);
  expect(await changeFormat(page, "SVG")).toEqual([]);
  await expect
    .poll(async () => (await savedDraft(page)).input.format)
    .toBe("svg");
  const svg = await savedDraft(page);
  expect(svg.input.promptImages).toEqual([commonImage]);
  expect(svg.input.messages).toBeUndefined();
  expect(svg.inactiveChatMessages).toEqual(draft.inactiveChatMessages);
  expect(svg.input.parameters).toEqual(draft.input.parameters);
});
