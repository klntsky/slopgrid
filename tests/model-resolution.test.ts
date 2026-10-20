import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Provider, type Model } from "../server/provider.js";
import { resolveGridModels } from "../server/model-resolution.js";
import type { Cell, GridInput } from "../server/domain.js";

const input: GridInput = {
  format: "markdown",
  prompt: "Draw $ROW with $COLUMN",
  rows: { kind: "variable", values: ["cat"] },
  columns: { kind: "variable", values: ["hat"] },
  model: "~fixture/latest",
  effort: "default",
  budgetUsd: 5,
};
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
test("published alias targets resolve in both axis orientations and duplicate targets collapse", () => {
  assert.equal(resolveGridModels(input, models()).model, "fixture/v1");
  for (const axis of ["rows", "columns"] as const) {
    const setup = {
      ...input,
      prompt: axis === "rows" ? "Draw $COLUMN" : "Draw $ROW",
      [axis]: {
        kind: "model",
        values: ["~fixture/latest", "fixture/v1", "fixture/v2"],
      },
    } as GridInput;
    const resolved = resolveGridModels(setup, models());
    assert.deepEqual(resolved[axis].values, ["fixture/v1", "fixture/v2"]);
    assert.equal(resolved.model, "");
  }
  assert.equal(input.model, "~fixture/latest");
});
test("catalog aliases without published targets remain unchanged in fixed and axis selections", () => {
  const catalog = models();
  assert.equal(
    resolveGridModels({ ...input, model: "fixture/chat-latest" }, catalog)
      .model,
    "fixture/chat-latest",
  );
  for (const side of ["rows", "columns"] as const) {
    const resolved = resolveGridModels(
      {
        ...input,
        [side]: {
          kind: "model",
          values: ["fixture/chat-latest", "~fixture/latest"],
        },
      },
      catalog,
    );
    assert.deepEqual(resolved[side].values, [
      "fixture/chat-latest",
      "fixture/v1",
    ]);
  }
});
test("unknown or cyclic aliases fail explicitly", () => {
  for (const id of ["fixture/model:latest", "~fixture/unknown-latest"])
    assert.throws(
      () => resolveGridModels({ ...input, model: id }, models()),
      /concrete model/i,
    );
  assert.throws(
    () => resolveGridModels(input, models("~fixture/latest")),
    /concrete model/i,
  );
});

test("image input admission checks every resolved generator in fixed and axis selections", () => {
  for (const format of ["chat-template", "image"] as const) {
    const source: GridInput = {
      ...input,
      format,
      inputReferences: [{ id: "image", name: "image.png" }],
    };
    const catalog = models().map((model) => ({
      ...model,
      imageInput: model.id !== "fixture/v2",
    }));
    assert.equal(resolveGridModels(source, catalog).model, "fixture/v1");
    assert.throws(
      () => resolveGridModels({ ...source, model: "fixture/v2" }, catalog),
      /does not support image inputs/,
    );
    for (const side of ["rows", "columns"] as const) {
      const selected: GridInput = {
        ...source,
        inputReferences: undefined,
        referenceGroups: { group: [{ id: "image", name: "image.png" }] },
        [side]: { kind: "model", values: ["~fixture/latest", "fixture/v2"] },
        [side === "rows" ? "columns" : "rows"]: {
          kind: "input_references",
          values: ["group"],
        },
      };
      assert.throws(
        () => resolveGridModels(selected, catalog),
        /does not support image inputs/,
      );
      const withoutImages = resolveGridModels(
        { ...selected, referenceGroups: undefined },
        catalog,
      );
      assert.deepEqual(withoutImages[side].values, [
        "fixture/v1",
        "fixture/v2",
      ]);
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

const judgedInput: GridInput = {
  ...input,
  judge: {
    criteria: [{ text: "Is there a cat?", correctAnswer: false }],
    model: "~fixture/latest",
    effort: "default",
  },
};
function judgeModels(): Model[] {
  return models().map((model) => ({
    ...model,
    structuredOutputs: true,
    imageInput: true,
  }));
}

test("chat images require image-capable fixed and axis judges, ignoring inactive reference groups", () => {
  const catalog = judgeModels().map((model) => ({
    ...model,
    imageInput: model.id !== "fixture/v2",
  }));
  const source: GridInput = {
    ...judgedInput,
    format: "chat-template",
    inputReferences: [{ id: "image", name: "image.png" }],
    judge: { ...judgedInput.judge!, model: "fixture/v2" },
  };
  assert.throws(
    () => resolveGridModels(source, catalog),
    /judge model must support image inputs/,
  );
  for (const side of ["rows", "columns"] as const) {
    assert.throws(
      () =>
        resolveGridModels(
          {
            ...source,
            [side]: {
              kind: "judge_model",
              values: ["fixture/v1", "fixture/v2"],
            },
          },
          catalog,
        ),
      /judge model must support image inputs/,
    );
  }
  const withoutImages = resolveGridModels(
    {
      ...source,
      inputReferences: undefined,
      referenceGroups: { unused: [{ id: "image", name: "image.png" }] },
    },
    catalog,
  );
  assert.equal(withoutImages.judge?.model, "fixture/v2");
});

test("judge aliases resolve in fixed settings and both axes, collapsing duplicate targets", () => {
  const resolved = resolveGridModels(judgedInput, judgeModels());
  assert.equal(resolved.judge?.model, "fixture/v1");
  assert.deepEqual(resolved.judge?.criteria, judgedInput.judge?.criteria);
  assert.equal(judgedInput.judge?.model, "~fixture/latest");
  for (const side of ["rows", "columns"] as const) {
    const setup = {
      ...judgedInput,
      [side]: {
        kind: "judge_model",
        values: ["~fixture/latest", "fixture/v1", "fixture/v2"],
      },
    } as GridInput;
    const axisResult = resolveGridModels(setup, judgeModels());
    assert.deepEqual(axisResult[side].values, ["fixture/v1", "fixture/v2"]);
    assert.equal(axisResult.judge?.model, "");
    assert.equal(axisResult.model, "fixture/v1");
  }
});

test("judge validation checks resolved target capabilities, not alias metadata", () => {
  for (const side of ["fixed", "rows", "columns"] as const) {
    const setup: GridInput =
      side === "fixed"
        ? judgedInput
        : {
            ...judgedInput,
            [side]: { kind: "judge_model", values: ["~fixture/latest"] },
          };
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
    const setup = (id: string): GridInput =>
      side === "fixed"
        ? { ...judgedInput, judge: { ...judgedInput.judge!, model: id } }
        : {
            ...judgedInput,
            [side]: { kind: "judge_model", values: [id] },
          };
    const catalog = judgeModels();
    const retained = resolveGridModels(setup("fixture/chat-latest"), catalog);
    assert.equal(
      side === "fixed" ? retained.judge?.model : retained[side].values[0],
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
      { message: "The judge model must support structured outputs." },
    );
    assert.throws(() => resolveGridModels(setup(""), catalog), {
      message: "Select a judge model.",
    });
  }
  // Concrete generator IDs keep their existing permissive resolution.
  assert.equal(
    resolveGridModels({ ...input, model: "fixture/unknown-version" }, models())
      .model,
    "fixture/unknown-version",
  );
});

test("judge validation requires explicit capabilities for each supported output format", () => {
  for (const format of ["markdown", "chat-template", "svg", "image"] as const) {
    const setup = { ...judgedInput, format };
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
    assert.throws(
      () =>
        resolveGridModels(
          setup,
          judgeModels().map((model) => ({ ...model, text: false })),
        ),
      { message: "The judge model must support structured outputs." },
    );
  }
  assert.throws(
    () => resolveGridModels({ ...judgedInput, format: "html" }, judgeModels()),
    { message: "Websites do not support a judge yet." },
  );
  assert.throws(
    () =>
      resolveGridModels(
        {
          ...input,
          rows: { kind: "judge_model", values: ["fixture/v1"] },
        },
        judgeModels(),
      ),
    { message: "Add a judge to use judge dimensions." },
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
  const setup: GridInput = {
    ...judgedInput,
    judge: {
      ...judgedInput.judge!,
      model: "fixture/judge-alias",
      effort: "high",
    },
    rows: { kind: "judge_effort", values: ["low", "high"] },
  };
  const result = resolveGridModels(setup, catalog);
  assert.equal(result.judge?.model, "fixture/v1");
  assert.equal(result.judge?.effort, "high");
  assert.deepEqual(result.rows, setup.rows);
  assert.throws(
    () =>
      resolveGridModels(
        setup,
        catalog.filter((model) => model.id !== "fixture/v1"),
      ),
    { message: "The judge model must support structured outputs." },
  );
  assert.throws(
    () => resolveGridModels({ ...input, rows: setup.rows }, catalog),
    { message: "Add a judge to use judge dimensions." },
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
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const selected = moving ? "fixture/chat-latest" : input.model;
    const expected = moving ? selected : "fixture/v1";
    const created = await post("/grids", { ...input, model: selected });
    await settle();
    assert.equal(store.get(created.id)!.input.model, expected);
    provider.target = "fixture/v2";
    await post(`/grids/${created.id}/retry`);
    await settle();
    const edited = await post(`/grids/${created.id}/edit`);
    assert.equal(edited.input.model, expected);
    await post("/grids", edited.input);
    await post(`/grids/${created.id}/publish`, { visibility: "unlisted" });
    const published = await (
      await fetch(`${origin}/api/grids/${created.id}`)
    ).json();
    assert.equal(published.input.model, expected);
    await post("/grids", published.input);
    await settle();
    assert.deepEqual(provider.called, [expected, expected, expected, expected]);
    assert.ok(!JSON.stringify(store.all()).includes("~fixture/latest"));
  });
