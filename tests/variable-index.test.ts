import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDefinition } from "./current-grid-fixture.js";
import { expandGrid, gridSchema } from "../server/domain.js";
import {
  createVariableIndex,
  interpolateVariables,
  promptVariableIssue,
} from "../server/prompt-variables.js";
import { generatorInputForCell } from "../server/generator-input.js";
import { expandPromptForTitle } from "../server/grid-title.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { analyzeGridCompatibility } from "../server/grid-compatibility.js";

const first = { id: "first", name: "first.png" };
const second = { id: "second", name: "second.png" };
const third = { id: "third", name: "third.png" };
test("unfinished duplicate names keep the first active slot in case-axis order", () => {
  const source = currentDefinition({
    caseAxes: ["columns", "rows"],
    variableNames: { rows: ["SHARED"], columns: ["SHARED", "SHARED"] },
    rows: [{ variable: [{ text: "row" }] }],
    columns: [
      { variable: [{ text: "first column" }, { text: "second column" }] },
    ],
  });
  assert.deepEqual(createVariableIndex(source).get("SHARED"), {
    side: "columns",
    index: 0,
  });
  assert.equal(
    interpolateVariables("$SHARED", source, 0, 0).text,
    "first column",
  );
  source.columns[0].variable![0] = null;
  assert.equal(
    interpolateVariables("$SHARED", source, 0, 0).text,
    "second column",
  );
  source.caseAxes.reverse();
  assert.equal(interpolateVariables("$SHARED", source, 0, 0).text, "row");
});

for (const side of ["rows", "columns"] as const) {
  test(`${side} repeated operations observe mutated names, slots, values and cell-local images`, () => {
    const source = currentDefinition({
      format: "chat-template",
      judge: true,
      caseAxes: [side],
      variableNames: { [side]: ["PROMPT", "EXPECTED"] },
      parameters: {
        model: { kind: "common", value: "plain" },
        judge_model: { kind: "common", value: "plain" },
        input: {
          kind: "common",
          value: [{ role: "user", content: "$PROMPT" }],
        },
        judge_criteria: {
          kind: "common",
          value: [{ text: "$EXPECTED", correctAnswer: true }],
        },
      },
      [side]: [
        {
          variable: [
            { text: "one", images: [first] },
            { text: "answer one", images: [third] },
          ],
        },
        { variable: [{ text: "two" }, { text: "answer two" }] },
      ],
    });
    const plain = {
      id: "plain",
      name: "Plain",
      text: true,
      image: false,
      imageInput: false,
      reasoning: false,
      reasoningMandatory: false,
      structuredOutputs: true,
    };
    const check = (
      texts: string[],
      images: ((typeof first)[] | undefined)[],
      fieldIndex: number,
    ) => {
      assert.equal(promptVariableIssue(source), undefined);
      const parsed = gridSchema.parse(source);
      for (const candidate of [source, parsed]) {
        const cells = expandGrid(candidate);
        assert.deepEqual(
          cells.map((cell) => cell.prompt),
          texts.map((text) => `user: ${text}`),
        );
        assert.deepEqual(
          cells.map((cell) => cell.messages![0].images),
          images,
        );
        assert.equal(
          expandPromptForTitle(candidate),
          `user: (${texts.join("|")})`,
        );
        for (const [caseIndex, cell] of cells.entries()) {
          assert.deepEqual(
            resolveCriteriaForCell(candidate, cell.row, cell.column),
            {
              criteria: [
                { text: `answer ${texts[caseIndex]}`, correctAnswer: true },
              ],
              ...(caseIndex === 0 ? { images: [third] } : {}),
            },
          );
        }
        const issues = analyzeGridCompatibility(candidate, [plain]).issues;
        assert.deepEqual(
          issues
            .filter((issue) => issue.parameters.includes("model"))
            .flatMap((issue) =>
              issue.origins.filter((origin) => origin.parameter === "variable"),
            ),
          images.flatMap((value, caseIndex) =>
            value?.length
              ? [{ parameter: "variable", source: side, caseIndex, fieldIndex }]
              : [],
          ),
        );
      }
    };
    check(["one", "two"], [[first], undefined], 0);

    source[side][0].variable![0]!.text = "updated";
    source[side][0].variable![0]!.images = [second];
    source[side][0].variable![1]!.text = "answer updated";
    source[side][1].variable![0]!.images = [first];
    check(["updated", "two"], [[second], [first]], 0);

    source.variableNames![side]![0] = "RENAMED";
    assert.throws(() => expandGrid(source), /Missing prompt variable \$PROMPT/);
    assert.equal(gridSchema.safeParse(source).success, false);
    generatorInputForCell(source, 0, 0)[0].content = "$RENAMED";
    check(["updated", "two"], [[second], [first]], 0);

    for (const [caseIndex, record] of source[side].entries()) {
      record.variable![0] = null;
      record.variable!.push({
        text: caseIndex === 0 ? "replacement" : "other",
        ...(caseIndex === 1 ? { images: [second] } : {}),
      });
      record.variable![1]!.text =
        caseIndex === 0 ? "answer replacement" : "answer other";
    }
    source.variableNames![side]!.push("LATEST");
    assert.throws(
      () => expandGrid(source),
      /Missing prompt variable \$RENAMED/,
    );
    generatorInputForCell(source, 0, 0)[0].content = "$LATEST";
    check(["replacement", "other"], [undefined, [second]], 2);
  });
}
