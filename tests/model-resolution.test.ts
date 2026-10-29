import { generatorInputForCell } from "../server/generator-input.js";
import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { Provider, type Model } from "../server/provider.js";
import { prepareGridModels } from "../server/model-resolution.js";
import {
  expandGrid,
  gridSchema,
  type Cell,
  type GridInput,
} from "../server/domain.js";
import { parameterValue } from "../server/parameters.js";
import { currentDefinition } from "./current-grid-fixture.js";
import { selectedReferences } from "../server/image-settings.js";
import { resolveCriteriaForCell } from "../server/judge-criteria.js";
import { pixelPng } from "./reference-image-fixture.js";

function resolveGridModels(input: GridInput, models: readonly Model[]) {
  return prepareGridModels(input, models).input;
}

const input = currentDefinition({
  parameters: {
    model: { kind: "common", value: "~fixture/latest" },
    input: {
      kind: "common",
      value: [{ role: "user", content: "Draw a cat with a hat" }],
    },
  },
  budgetUsd: 5,
});
function models(target = "fixture/v1"): Model[] {
  return [
    { id: "~fixture/latest", aliasTarget: target },
    { id: "fixture/v1" },
    { id: "fixture/v2" },
    { id: "fixture/chat-latest" },
  ].map((m) => ({
    ...m,
    name: m.id,
    image: false,
    imageInput: false,
    text: true,
    reasoning: false,
    reasoningMandatory: false,
  }));
}

test("model admission retains the resolved expansion for workflow creation", () => {
  const prepared = prepareGridModels(gridSchema.parse(input), models());
  assert.equal(parameterValue(prepared.input, "model", 0, 0), "fixture/v1");
  assert.deepEqual(prepared.cells, expandGrid(prepared.input));
  assert.equal(prepared.cells[0].model, "fixture/v1");
});

test("Chat completion requires text output after alias resolution in common and case model selections", () => {
  const catalog = models().map((model) => ({
    ...model,
    text: model.id !== "fixture/v1",
    image: model.id === "fixture/v1",
    chatImageOutput: model.id === "fixture/v2",
  }));
  for (const model of ["fixture/v1", "~fixture/latest"]) {
    for (const side of ["common", "rows", "columns"] as const) {
      const source = currentDefinition({
        format: "chat-template",
        parameters: {
          model:
            side === "common"
              ? { kind: "common", value: model }
              : { kind: side },
          input: {
            kind: "common",
            value: [{ role: "user", content: "Draw a cat" }],
          },
        },
        ...(side === "common" ? {} : { [side]: [{ model }] }),
      });
      assert.throws(() => resolveGridModels(source, catalog));
    }
  }
  for (const model of ["fixture/v2", "fixture/chat-latest"]) {
    const source = currentDefinition({
      format: "chat-template",
      parameters: { model: { kind: "common", value: model } },
    });
    assert.equal(
      parameterValue(resolveGridModels(source, catalog), "model", 0, 0),
      model,
    );
  }
});

test("published alias targets resolve in both axis orientations and duplicate targets collapse", () => {
  assert.equal(
    parameterValue(resolveGridModels(input, models()), "model", 0, 0),
    "fixture/v1",
  );
  for (const axis of ["rows", "columns"] as const) {
    const setup = currentDefinition({
      ...input,
      parameters: { ...input.parameters, model: { kind: axis } },
      [axis]: ["~fixture/latest", "fixture/v1", "fixture/v2"].map((model) => ({
        model,
      })),
    });
    const resolved = resolveGridModels(setup, models());
    assert.deepEqual(
      resolved[axis].map((record) => record.model),
      ["fixture/v1", "fixture/v2"],
    );
    assert.deepEqual(resolved.parameters.model, { kind: axis });
  }
  assert.equal(parameterValue(input, "model", 0, 0), "~fixture/latest");
});
test("catalog aliases without published targets remain unchanged in fixed and axis selections", () => {
  const catalog = models();
  assert.equal(
    parameterValue(
      resolveGridModels(
        currentDefinition({
          ...input,
          parameters: {
            ...input.parameters,
            model: { kind: "common", value: "fixture/chat-latest" },
          },
        }),
        catalog,
      ),
      "model",
      0,
      0,
    ),
    "fixture/chat-latest",
  );
  for (const side of ["rows", "columns"] as const) {
    const resolved = resolveGridModels(
      currentDefinition({
        ...input,
        parameters: { ...input.parameters, model: { kind: side } },
        [side]: ["fixture/chat-latest", "~fixture/latest"].map((model) => ({
          model,
        })),
      }),
      catalog,
    );
    assert.deepEqual(
      resolved[side].map((record) => record.model),
      ["fixture/chat-latest", "fixture/v1"],
    );
  }
});
test("unknown or cyclic aliases fail explicitly", () => {
  for (const id of ["fixture/model:latest", "~fixture/unknown-latest"])
    assert.throws(
      () =>
        resolveGridModels(
          currentDefinition({
            ...input,
            parameters: {
              ...input.parameters,
              model: { kind: "common", value: id },
            },
          }),
          models(),
        ),
      /concrete model/i,
    );
  assert.throws(
    () => resolveGridModels(input, models("~fixture/latest")),
    /concrete model/i,
  );
});

test("image input admission checks every resolved generator in fixed and axis selections", () => {
  for (const format of [
    "chat-template",
    "image",
    "markdown",
    "svg",
    "html",
  ] as const) {
    const source = currentDefinition({
      format,
      parameters: {
        model: { kind: "common", value: "~fixture/latest" },
        input: {
          kind: "common",
          value:
            format === "chat-template"
              ? [
                  { role: "user", content: "First question." },
                  { role: "unfilled", content: "" },
                  {
                    role: "user",
                    content: "",
                    images: [{ id: "image", name: "image.png" }],
                  },
                ]
              : [
                  {
                    role: "user",
                    content: "Draw a cat",
                    images: [{ id: "image", name: "image.png" }],
                  },
                ],
        },
      },
    });
    const catalog = models().map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v2",
    }));
    assert.equal(
      parameterValue(resolveGridModels(source, catalog), "model", 0, 0),
      "fixture/v1",
    );
    assert.throws(
      () =>
        resolveGridModels(
          currentDefinition({
            ...source,
            parameters: {
              ...source.parameters,
              model: { kind: "common", value: "fixture/v2" },
            },
          }),
          catalog,
        ),
      /does not support image inputs/,
    );
    for (const side of ["rows", "columns"] as const) {
      const opposite = side === "rows" ? "columns" : "rows";
      const selected = currentDefinition({
        ...source,
        caseAxes: format === "image" ? [opposite] : [],
        parameters: {
          ...source.parameters,
          model: { kind: side },
          input: {
            kind: "common",
            value:
              format === "image"
                ? [
                    {
                      role: "user",
                      content: `$${opposite === "rows" ? "ROW" : "COLUMN"}1`,
                    },
                  ]
                : generatorInputForCell(source, 0, 0),
          },
        },
        [side]: ["~fixture/latest", "fixture/v2"].map((model) => ({ model })),
        ...(format === "image"
          ? {
              [opposite]: [
                {
                  variable: [
                    {
                      text: "Describe it",
                      images: [{ id: "image", name: "image.png" }],
                    },
                  ],
                },
              ],
            }
          : {}),
      });
      assert.throws(
        () => resolveGridModels(selected, catalog),
        /does not support image inputs/,
      );
      const withoutImages = resolveGridModels(
        currentDefinition({
          ...selected,
          caseAxes: [],
          parameters: {
            ...source.parameters,
            model: { kind: side },
            input: {
              kind: "common",
              value: generatorInputForCell(source, 0, 0)?.map(
                ({ role, content }) => ({
                  role,
                  content: role === "user" && !content ? "Text only." : content,
                }),
              ),
            },
          },
          [opposite]: [{}],
        }),
        catalog,
      );
      assert.deepEqual(
        withoutImages[side].map((record) => record.model),
        ["fixture/v1", "fixture/v2"],
      );
    }
    const unsupportedTarget = catalog.map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v1",
    }));
    assert.throws(
      () => resolveGridModels(source, unsupportedTarget),
      /does not support image inputs/,
    );
  }
});

const judgedInput = currentDefinition({
  ...input,
  judge: true,
  parameters: {
    ...input.parameters,
    judge_model: { kind: "common", value: "~fixture/latest" },
    judge_effort: { kind: "common", value: "default" },
    judge_criteria: {
      kind: "common",
      value: [{ text: "Is there a cat?", correctAnswer: false }],
    },
  },
});
function judgeModels(): Model[] {
  return models().map((model) => ({
    ...model,
    structuredOutputs: true,
    imageInput: true,
  }));
}

test("future chat images require image-capable fixed and axis judges", () => {
  const catalog = judgeModels().map((model) => ({
    ...model,
    imageInput: model.id !== "fixture/v2",
  }));
  const source = currentDefinition({
    format: "chat-template",
    judge: true,
    parameters: {
      model: { kind: "common", value: "~fixture/latest" },
      judge_model: { kind: "common", value: "fixture/v2" },
      input: {
        kind: "common",
        value: [
          { role: "user", content: "First question." },
          { role: "unfilled", content: "" },
          {
            role: "user",
            content: "",
            images: [{ id: "image", name: "image.png" }],
          },
        ],
      },
    },
  });
  assert.throws(
    () => resolveGridModels(source, catalog),
    /judge model must support image inputs/,
  );
  for (const side of ["rows", "columns"] as const) {
    assert.throws(
      () =>
        resolveGridModels(
          currentDefinition({
            ...source,
            parameters: { ...source.parameters, judge_model: { kind: side } },
            [side]: ["fixture/v1", "fixture/v2"].map((judge_model) => ({
              judge_model,
            })),
          }),
          catalog,
        ),
      /judge model must support image inputs/,
    );
  }
  const withoutImages = resolveGridModels(
    currentDefinition({
      ...source,
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: generatorInputForCell(source, 0, 0)?.map(
            ({ role, content }) => ({
              role,
              content: role === "user" && !content ? "Text only." : content,
            }),
          ),
        },
      },
    }),
    catalog,
  );
  assert.equal(
    parameterValue(withoutImages, "judge_model", 0, 0),
    "fixture/v2",
  );
});

for (const format of ["markdown", "svg"] as const)
  test(`${format} common prompt images require image-capable fixed and axis judges`, () => {
    const common = { id: "common", name: "common.png" };
    const variable = { id: "variable", name: "variable.png" };
    const unused = { id: "unused", name: "unused.png" };
    const source = currentDefinition({
      ...judgedInput,
      format,
      parameters: {
        ...judgedInput.parameters,
        judge_model: { kind: "common", value: "fixture/v2" },
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(judgedInput, 0, 0)[0],
              role: "user",
              content: "$ROW1",
              images: [common],
            },
          ],
        },
      },
      rows: [
        {
          variable: [
            { text: "Describe it.", images: [variable, common] },
            { text: "Unused.", images: [unused] },
          ],
        },
      ],
      caseAxes: ["rows"],
    });
    assert.deepEqual(selectedReferences(source), [common, variable, unused]);
    assert.deepEqual(expandGrid(source)[0].messages?.[0].images, [
      common,
      variable,
    ]);
    const catalog = judgeModels().map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v2",
    }));
    assert.throws(
      () => resolveGridModels(source, catalog),
      /judge model must support image inputs/,
    );
    assert.equal(
      parameterValue(
        resolveGridModels(
          currentDefinition({
            ...source,
            parameters: {
              ...source.parameters,
              judge_model: { kind: "common", value: "fixture/v1" },
            },
          }),
          catalog,
        ),
        "judge_model",
        0,
        0,
      ),
      "fixture/v1",
    );
    for (const side of ["rows", "columns"] as const)
      assert.throws(
        () =>
          resolveGridModels(
            currentDefinition({
              ...source,
              parameters: {
                ...source.parameters,
                judge_model: { kind: side },
                input: {
                  kind: "common",
                  value: [
                    {
                      ...generatorInputForCell(source, 0, 0)[0],
                      role: "user",
                      content: "Describe it.",
                    },
                  ],
                },
              },
              rows: [{}],
              [side]: ["fixture/v1", "fixture/v2"].map((judge_model) => ({
                judge_model,
              })),
            }),
            catalog,
          ),
        /judge model must support image inputs/,
      );
    const textOnly = currentDefinition({
      ...source,
      parameters: {
        ...source.parameters,
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(source, 0, 0)[0],
              role: "user",
              content: "Describe it.",
              images: [],
            },
          ],
        },
      },
    });
    assert.deepEqual(
      expandGrid(textOnly).flatMap(
        (cell) =>
          cell.messages?.flatMap((message) => message.images ?? []) ?? [],
      ),
      [],
    );
    assert.deepEqual(resolveCriteriaForCell(textOnly, 0, 0).images ?? [], []);
    if (format === "markdown")
      assert.equal(
        parameterValue(
          resolveGridModels(textOnly, catalog),
          "judge_model",
          0,
          0,
        ),
        "fixture/v2",
      );
    else
      assert.throws(
        () => resolveGridModels(textOnly, catalog),
        /image inputs for SVG and Image outputs/,
      );
  });

for (const format of ["markdown", "svg", "html"] as const)
  test(`${format} rejects unsupported prompt-image models once at setup without creating cells`, async (t) => {
    const provider = new Provider();
    const catalog = judgeModels().map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v2",
    }));
    t.mock.method(provider, "models", async () => catalog);
    t.mock.method(provider, "generate", async () => {
      throw new Error("Generation must not start for an unsupported model");
    });
    const { origin, store } = await appFixture(t, { provider });
    const session = { id: "a".repeat(48), created: Date.now() };
    store.saveSession(session);
    const image = store.references.add(pixelPng, "private.png", session)!;
    const source = currentDefinition({
      format,
      parameters: {
        model: { kind: "rows" },
        effort: { kind: "columns" },
        input: {
          kind: "common",
          value: [
            {
              role: "user",
              content: "",
              images: [image],
            },
          ],
        },
      },
      rows: [{ model: "fixture/v2" }],
      columns: [{ effort: "none" }],
    });
    const cases = [
      { input: source, error: /selected model does not support image inputs/ },
      ...(format === "html"
        ? []
        : [
            {
              input: currentDefinition({
                ...source,
                judge: true,
                parameters: {
                  ...source.parameters,
                  judge_model: { kind: "common", value: "fixture/v2" },
                },
                rows: [{ model: "fixture/v1" }],
              }),
              error: /judge model must support image inputs/,
            },
          ]),
    ];
    const before = store.all().map((grid) => grid.id);
    for (const scenario of cases) {
      const response = await fetch(`${origin}/api/grids`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer fixture-key",
          Cookie: `slopgrid=${session.id}`,
        },
        body: JSON.stringify(scenario.input),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, scenario.error);
    }
    assert.deepEqual(
      store.all().map((grid) => grid.id),
      before,
    );
  });

test("variable image admission follows generator and judge consumption, not field ownership", () => {
  const expected = { id: "expected", name: "answer.png" };
  const unused = { id: "unused", name: "unused.png" };
  const catalog = judgeModels().map((model) => ({
    ...model,
    imageInput: model.id !== "fixture/v2",
  }));
  for (const side of ["rows", "columns"] as const) {
    const token = side === "rows" ? "$ROW2" : "$COLUMN2";
    const opposite = side === "rows" ? "columns" : "rows";
    const source = currentDefinition({
      judge: true,
      parameters: {
        model: { kind: opposite },
        judge_model: { kind: "common", value: "fixture/v1" },
        judge_criteria: {
          kind: "common",
          value: [{ text: `Matches ${token}?`, correctAnswer: false }],
        },
        input: {
          kind: "common",
          value: [{ role: "user", content: "Describe a shape." }],
        },
      },
      [opposite]: [{ model: "fixture/v2" }],
      [side]: [
        {
          variable: [
            { text: "unused", images: [unused] },
            { text: "Expected shape", images: [expected] },
          ],
        },
      ],
      caseAxes: [side],
    });
    assert.deepEqual(selectedReferences(source), [unused, expected]);
    assert.doesNotThrow(() => resolveGridModels(source, catalog));
    assert.throws(
      () =>
        resolveGridModels(
          currentDefinition({
            ...source,
            parameters: {
              ...source.parameters,
              judge_model: { kind: "common", value: "fixture/v2" },
            },
          }),
          catalog,
        ),
      /judge model must support image inputs/,
    );
    assert.throws(
      () =>
        resolveGridModels(
          {
            ...source,
            parameters: {
              ...source.parameters,
              input: {
                kind: "common",
                value: [
                  {
                    ...generatorInputForCell(source, 0, 0)[0],
                    role: "user",
                    content: token,
                  },
                ],
              },
            },
          },
          catalog,
        ),
      /selected model does not support image inputs/,
    );
    const visionGenerator = currentDefinition({
      ...source,
      [opposite]: [{ model: "fixture/v1" }],
      parameters: {
        ...source.parameters,
        judge_model: { kind: "common", value: "fixture/v2" },
        judge_criteria: {
          kind: "common",
          value: [{ text: "A shape?", correctAnswer: true }],
        },
        input: {
          kind: "common",
          value: [
            {
              ...generatorInputForCell(source, 0, 0)[0],
              role: "user",
              content: token,
            },
          ],
        },
      },
    });
    assert.throws(
      () => resolveGridModels(visionGenerator, catalog),
      /judge model must support image inputs/,
    );
  }
});

for (const side of ["rows", "columns"] as const)
  test(`${side} rubric image admission includes only fields consumed by that exact case`, () => {
    const first = { id: "first-unused", name: "first.png" };
    const second = { id: "second-unused", name: "second.png" };
    const token = side === "rows" ? "$ROW" : "$COLUMN";
    const catalog = judgeModels().map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v2",
    }));
    const source = currentDefinition({
      judge: true,
      parameters: {
        model: { kind: "common", value: "fixture/v2" },
        judge_model: { kind: "common", value: "fixture/v2" },
        judge_effort: { kind: "common", value: "none" },
        judge_criteria: { kind: side },
        input: {
          kind: "common",
          value: [{ role: "user", content: "Describe a shape." }],
        },
      },
      [side]: [
        {
          variable: [
            { text: "first text" },
            { text: "unused", images: [first] },
          ],
          judge_criteria: [
            { text: `Matches ${token}1?`, correctAnswer: false },
          ],
        },
        {
          variable: [
            { text: "unused", images: [second] },
            { text: "second text" },
          ],
          judge_criteria: [{ text: `Matches ${token}2?`, correctAnswer: true }],
        },
      ],
      caseAxes: [side],
    });
    assert.deepEqual(selectedReferences(source), [first, second]);
    assert.doesNotThrow(() => resolveGridModels(source, catalog));
    for (const index of [0, 1]) {
      const changed = currentDefinition({
        ...source,
        [side]: source[side].map((record, caseIndex) => ({
          ...record,
          judge_criteria: [
            {
              text: `Matches ${token}${caseIndex === index ? (caseIndex === 0 ? 2 : 1) : caseIndex === 0 ? 1 : 2}?`,
              correctAnswer: caseIndex === 1,
            },
          ],
        })),
      });
      assert.throws(
        () => resolveGridModels(changed, catalog),
        /judge model must support image inputs/,
      );
      assert.doesNotThrow(() =>
        resolveGridModels(
          currentDefinition({
            ...changed,
            parameters: {
              ...changed.parameters,
              judge_model: { kind: "common", value: "fixture/v1" },
            },
          }),
          catalog,
        ),
      );
    }
    assert.throws(
      () =>
        resolveGridModels(
          currentDefinition({
            ...source,
            parameters: {
              ...source.parameters,
              judge_criteria: {
                kind: "common",
                value: [{ text: `Matches ${token}1?`, correctAnswer: true }],
              },
            },
            [side]: source[side].map(
              ({ judge_criteria: _criteria, ...record }) => record,
            ),
          }),
          catalog,
        ),
      /judge model must support image inputs/,
      "shared rubrics still consume the referenced field in every case",
    );
  });

test("judge aliases resolve in fixed settings and both axes, collapsing duplicate targets", () => {
  const resolved = resolveGridModels(judgedInput, judgeModels());
  assert.equal(parameterValue(resolved, "judge_model", 0, 0), "fixture/v1");
  assert.deepEqual(
    resolved.parameters.judge_criteria,
    judgedInput.parameters.judge_criteria,
  );
  assert.equal(
    parameterValue(judgedInput, "judge_model", 0, 0),
    "~fixture/latest",
  );
  for (const side of ["rows", "columns"] as const) {
    const setup = currentDefinition({
      ...judgedInput,
      parameters: { ...judgedInput.parameters, judge_model: { kind: side } },
      [side]: ["~fixture/latest", "fixture/v1", "fixture/v2"].map(
        (judge_model) => ({ judge_model }),
      ),
    });
    const axisResult = resolveGridModels(setup, judgeModels());
    assert.deepEqual(
      axisResult[side].map((record) => record.judge_model),
      ["fixture/v1", "fixture/v2"],
    );
    assert.deepEqual(axisResult.parameters.judge_model, { kind: side });
    assert.equal(parameterValue(axisResult, "model", 0, 0), "fixture/v1");
  }
});

test("judge validation checks resolved target capabilities, not alias metadata", () => {
  for (const side of ["fixed", "rows", "columns"] as const) {
    const setup =
      side === "fixed"
        ? judgedInput
        : currentDefinition({
            ...judgedInput,
            parameters: {
              ...judgedInput.parameters,
              judge_model: { kind: side },
            },
            [side]: [{ judge_model: "~fixture/latest" }],
          });
    const eligibleTarget = judgeModels().map((model) => ({
      ...model,
      structuredOutputs: model.id !== "~fixture/latest",
    }));
    assert.doesNotThrow(() => resolveGridModels(setup, eligibleTarget));
    const ineligibleTarget = judgeModels().map((model) => ({
      ...model,
      structuredOutputs: model.id !== "fixture/v1",
    }));
    assert.throws(() => resolveGridModels(setup, ineligibleTarget), {
      message: "The judge model must support structured outputs.",
    });
  }
});

test("judge selections retain catalog moving aliases but reject missing and cyclic targets", () => {
  for (const side of ["fixed", "rows", "columns"] as const) {
    const setup = (id: string) =>
      currentDefinition({
        ...judgedInput,
        parameters: {
          ...judgedInput.parameters,
          judge_model:
            side === "fixed" ? { kind: "common", value: id } : { kind: side },
        },
        ...(side === "fixed" ? {} : { [side]: [{ judge_model: id }] }),
      });
    const catalog = judgeModels();
    const retained = resolveGridModels(setup("fixture/chat-latest"), catalog);
    assert.equal(
      parameterValue(retained, "judge_model", 0, 0),
      "fixture/chat-latest",
    );
    for (const id of ["fixture/model:latest", "~fixture/unknown-latest"])
      assert.throws(
        () => resolveGridModels(setup(id), catalog),
        /concrete model/i,
      );
    const cyclic = catalog.map((model) => ({
      ...model,
      aliasTarget:
        model.id === "fixture/v1" ? "~fixture/latest" : model.aliasTarget,
    }));
    assert.throws(
      () => resolveGridModels(setup("~fixture/latest"), cyclic),
      /concrete model/i,
    );
    assert.throws(
      () => resolveGridModels(setup("fixture/unknown-version"), catalog),
      {
        message: "The judge model must support structured outputs.",
      },
    );
    assert.throws(() => gridSchema.parse(setup("")), /Select a judge model/);
  }
  // Concrete generator IDs keep their existing permissive resolution.
  assert.equal(
    parameterValue(
      resolveGridModels(
        currentDefinition({
          ...input,
          parameters: {
            ...input.parameters,
            model: { kind: "common", value: "fixture/unknown-version" },
          },
        }),
        models(),
      ),
      "model",
      0,
      0,
    ),
    "fixture/unknown-version",
  );
});

test("judge validation requires explicit capabilities for each supported output format", () => {
  for (const format of ["markdown", "chat-template", "svg", "image"] as const) {
    const setup = currentDefinition({
      format,
      judge: true,
      parameters: {
        model: { kind: "common", value: "fixture/v2" },
        judge_model: { kind: "common", value: "~fixture/latest" },
      },
    });
    assert.doesNotThrow(() => resolveGridModels(setup, judgeModels()));
    for (const structuredOutputs of [undefined, false])
      assert.throws(
        () =>
          resolveGridModels(
            setup,
            judgeModels().map((model) => ({ ...model, structuredOutputs })),
          ),
        { message: "The judge model must support structured outputs." },
      );
    const noImageInput = judgeModels().map((model) => ({
      ...model,
      imageInput: false,
    }));
    if (format === "svg" || format === "image")
      assert.throws(() => resolveGridModels(setup, noImageInput), {
        message:
          "The judge model must support image inputs for SVG and Image outputs.",
      });
    else assert.doesNotThrow(() => resolveGridModels(setup, noImageInput));
    assert.throws(() =>
      resolveGridModels(
        setup,
        judgeModels().map((model) => ({
          ...model,
          text: model.id === "fixture/v2",
        })),
      ),
    );
  }
  assert.throws(
    () => resolveGridModels({ ...judgedInput, format: "html" }, judgeModels()),
    { message: "Websites do not support a judge yet." },
  );
  assert.throws(
    () =>
      gridSchema.parse(
        currentDefinition({
          ...input,
          parameters: { ...input.parameters, judge_model: { kind: "rows" } },
          rows: [{ judge_model: "fixture/v1" }],
        }),
      ),
    /judge_model is not applicable/,
  );
});

test("judge alias chains resolve fully and judge effort axes retain their values", () => {
  const catalog = [
    ...judgeModels(),
    {
      ...judgeModels()[0],
      id: "fixture/judge-alias",
      aliasTarget: "~fixture/latest",
    },
  ];
  const setup = currentDefinition({
    ...judgedInput,
    parameters: {
      ...judgedInput.parameters,
      judge_model: { kind: "common", value: "fixture/judge-alias" },
      judge_effort: { kind: "rows" },
    },
    rows: [{ judge_effort: "low" }, { judge_effort: "high" }],
  });
  const result = resolveGridModels(setup, catalog);
  assert.equal(parameterValue(result, "judge_model", 0, 0), "fixture/v1");
  assert.deepEqual(result.rows, setup.rows);
  assert.deepEqual(
    expandGrid(result).map((cell) => cell.judge?.effort),
    ["low", "high"],
  );
  assert.throws(
    () =>
      resolveGridModels(
        setup,
        catalog.filter((model) => model.id !== "fixture/v1"),
      ),
    { message: "The judge model must support structured outputs." },
  );
  assert.throws(
    () =>
      gridSchema.parse(
        currentDefinition({
          ...input,
          parameters: { ...input.parameters, judge_effort: { kind: "rows" } },
          rows: setup.rows,
        }),
      ),
    /judge_effort is not applicable/,
  );
});

for (const moving of [false, true])
  test(`saved ${moving ? "moving alias" : "concrete model"} IDs survive retries, Edit, publishing, and Fork`, async (t) => {
    class FixtureProvider extends Provider {
      override async balanceUsd() {
        return 100;
      }
      target = "fixture/v1";
      failOnce = true;
      called: string[] = [];
      override async models() {
        return models(this.target);
      }
      override async generate(
        _key: string,
        _format: GridInput["format"],
        cell: Cell,
      ) {
        this.called.push(cell.model);
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error("Fixture failure");
        }
        return {
          signature: "fixture-signature",
          files: { "index.md": "Generated output" },
        };
      }
    }
    const provider = new FixtureProvider();
    const { origin, store } = await appFixture(t, { provider });
    const owner = "a".repeat(48);
    store.saveSession({ id: owner, key: "fixture-key", created: Date.now() });
    async function post(path: string, body?: unknown) {
      const response = await fetch(`${origin}/api${path}`, {
        method: "POST",
        headers: {
          cookie: `slopgrid=${owner}`,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    async function settle(calls: number) {
      const deadline = Date.now() + 5000;
      while (
        provider.called.length < calls ||
        store.all().some((grid) => grid.status === "running")
      ) {
        assert.ok(
          Date.now() < deadline,
          "Expected provider calls and settled grids",
        );
        await immediate();
      }
    }
    const selected = moving
      ? "fixture/chat-latest"
      : parameterValue(input, "model", 0, 0)!;
    const expected = moving ? selected : "fixture/v1";
    const created = await post(
      "/grids",
      currentDefinition({
        ...input,
        parameters: {
          ...input.parameters,
          model: { kind: "common", value: selected },
        },
      }),
    );
    await settle(1);
    const storedInput = store.get(created.id)!.input;
    assert.equal(parameterValue(storedInput, "model", 0, 0), expected);
    provider.target = "fixture/v2";
    await post(`/grids/${created.id}/retry`);
    await settle(2);
    const edited = await post(`/grids/${created.id}/edit`);
    assert.equal(parameterValue(edited.input, "model", 0, 0), expected);
    await post("/grids", edited.input);
    await post(`/grids/${created.id}/publish`, { visibility: "unlisted" });
    const published = await (
      await fetch(`${origin}/api/grids/${created.id}`)
    ).json();
    assert.equal(parameterValue(published.input, "model", 0, 0), expected);
    await post("/grids", published.input);
    await settle(4);
    assert.deepEqual(provider.called, [expected, expected, expected, expected]);
    assert.ok(!JSON.stringify(store.all()).includes("~fixture/latest"));
  });

for (const side of ["rows", "columns"] as const) {
  test(`${side} model aliases retain full input cases even when targets are equal`, () => {
    const source = currentDefinition({
      caseAxes: [side],
      parameters: { input: { kind: side }, model: { kind: side } },
      [side]: [
        {
          id: "first",
          model: "~fixture/latest",
          input: [{ role: "user" as const, content: "First prompt" }],
        },
        {
          id: "second",
          model: "fixture/v1",
          input: [{ role: "user" as const, content: "Second prompt" }],
        },
      ],
    });
    const resolved = resolveGridModels(source, models());
    assert.deepEqual(resolved.caseAxes, [side]);
    assert.deepEqual(
      resolved[side].map((record) => [record.id, record.model, record.input]),
      [
        ["first", "fixture/v1", source[side][0].input],
        ["second", "fixture/v1", source[side][1].input],
      ],
    );
    assert.deepEqual(
      expandGrid(gridSchema.parse(resolved)).map((cell) => cell.prompt),
      ["First prompt", "Second prompt"],
    );
  });
}
