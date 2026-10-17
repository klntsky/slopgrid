import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canJudge,
  judgeModelIssue,
  thinkingEffortSupport,
  imageSettingsSupport,
} from "../server/compatibility.js";
import type { Model } from "../server/provider.js";

const models: Model[] = [
  {
    id: "required",
    name: "Required thinker",
    image: false,
    imageInput: false,
    text: true,
    reasoning: true,
    reasoningMandatory: true,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "plain",
    name: "Plain model",
    image: false,
    imageInput: false,
    text: true,
    reasoning: false,
    reasoningMandatory: false,
    reasoningEfforts: ["none"],
  },
  {
    id: "fixed",
    name: "Fixed thinker",
    image: false,
    imageInput: false,
    text: true,
    reasoning: true,
    reasoningMandatory: true,
    reasoningEfforts: [],
  },
  {
    id: "router",
    name: "Dynamic router",
    image: false,
    imageInput: false,
    text: true,
    reasoning: true,
    reasoningMandatory: false,
  },
];
test("thinking effort support distinguishes supported, unsupported, and unknown combinations", () => {
  assert.equal(thinkingEffortSupport(models[0], "high"), "supported");
  assert.equal(thinkingEffortSupport(models[0], "none"), "unsupported");
  assert.equal(thinkingEffortSupport(models[0], "max"), "unsupported");
  assert.equal(thinkingEffortSupport(models[1], "none"), "supported");
  assert.equal(thinkingEffortSupport(models[2], "high"), "unsupported");
  assert.equal(thinkingEffortSupport(models[3], "high"), "unknown");
  assert.equal(thinkingEffortSupport(models[3], "default"), "supported");
  assert.equal(thinkingEffortSupport(undefined, "default"), "unsupported");
});

test("judges require explicit structured text output, never response_format alone", () => {
  const judge: Model = {
    ...models[1],
    structuredOutputs: true,
    imageInput: true,
  };
  for (const format of ["markdown", "chat-template", "svg", "image"] as const) {
    assert.equal(canJudge(judge, format), true);
    assert.equal(judgeModelIssue(judge, format), undefined);
    for (const structuredOutputs of [false, undefined]) {
      const responseFormatOnly = {
        ...judge,
        structuredOutputs,
        supportedParameters: ["response_format"],
      };
      assert.equal(canJudge(responseFormatOnly, format), false);
      assert.equal(
        judgeModelIssue(responseFormatOnly, format),
        "The judge model must support structured outputs.",
      );
    }
    assert.equal(canJudge({ ...judge, text: false }, format), false);
    assert.equal(
      judgeModelIssue(undefined, format),
      "The judge model must support structured outputs.",
    );
  }
  assert.equal(canJudge(judge, "html"), false);
  assert.equal(
    judgeModelIssue(judge, "html"),
    "Websites do not support a judge yet.",
  );
});

test("SVG and Image judges require image input, not image output", () => {
  const textJudge: Model = {
    ...models[1],
    structuredOutputs: true,
    image: true,
    imageInput: false,
  };
  for (const format of ["markdown", "chat-template"] as const) {
    assert.equal(canJudge(textJudge, format), true);
    assert.equal(judgeModelIssue(textJudge, format), undefined);
  }
  for (const format of ["svg", "image"] as const) {
    for (const model of [
      textJudge,
      { ...textJudge, imageInput: undefined } as unknown as Model,
    ]) {
      assert.equal(canJudge(model, format), false);
      assert.equal(
        judgeModelIssue(model, format),
        "The judge model must support image inputs for SVG and Image outputs.",
      );
    }
    assert.equal(canJudge({ ...textJudge, image: false, imageInput: true }, format), true);
  }
});

test("image compatibility requires one endpoint to support the whole combination", () => {
  const endpoints: import("../server/image-settings.js").ImageCapabilities[] = [
    {
      resolution: { type: "enum", values: ["1K"] },
      quality: { type: "enum", values: ["high"] },
    },
    {
      resolution: { type: "enum", values: ["2K"] },
      background: { type: "enum", values: ["transparent"] },
      input_references: { type: "range", min: 0, max: 2 },
    },
  ];
  assert.equal(
    imageSettingsSupport(endpoints, { size: "2K", quality: "high" }).support,
    "unsupported",
  );
  assert.equal(
    imageSettingsSupport(endpoints, {
      size: "2K",
      background: "transparent",
      input_references: ["a", "b"],
    }).support,
    "supported",
  );
  assert.equal(
    imageSettingsSupport(endpoints, {
      size: "2K",
      input_references: ["a", "b", "c"],
    }).support,
    "unsupported",
  );
  assert.equal(
    imageSettingsSupport(endpoints, { size: "1536x1024" }).support,
    "unknown",
  );
  assert.equal(
    imageSettingsSupport(undefined, { size: "2K" }).support,
    "unknown",
  );
  assert.equal(
    imageSettingsSupport(
      [{ input_references: { type: "range", min: 1, max: 10 } }],
      {},
    ).support,
    "unsupported",
  );
  assert.equal(
    imageSettingsSupport(undefined, { size: "1536x1024", aspect_ratio: "1:1" })
      .support,
    "unsupported",
  );
  assert.equal(
    imageSettingsSupport(
      [
        {
          size: { type: "enum", values: ["1536x1024"] },
          aspect_ratio: { type: "enum", values: ["3:2"] },
        },
      ],
      { size: "1536x1024", aspect_ratio: "3:2" },
    ).support,
    "supported",
  );
});

test("Auto settings use default compatibility even when an endpoint has no matching parameter", () => {
  const endpoints = [{ resolution: { type: "enum", values: ["1K"] } }];
  assert.deepEqual(
    imageSettingsSupport(endpoints, {
      size: "auto",
      aspect_ratio: "auto",
      quality: "auto",
      background: "auto",
      input_references: [],
    }),
    imageSettingsSupport(endpoints, {}),
  );
  assert.equal(
    imageSettingsSupport(endpoints, { quality: "high" }).support,
    "unsupported",
  );
});

test("image incompatibilities identify each failing parameter without blaming unrelated settings", () => {
  const endpoints = [
    {
      resolution: { type: "enum", values: ["1K"] },
      quality: { type: "enum", values: ["high"] },
      background: { type: "enum", values: ["opaque"] },
      input_references: { type: "range", min: 0, max: 2 },
    },
  ];
  const result = imageSettingsSupport(endpoints, {
    size: "1K",
    quality: "low",
    background: "transparent",
    input_references: ["a", "b", "c"],
  });
  assert.equal(result.parameters.size.support, "supported");
  for (const kind of ["quality", "background", "input_references"] as const)
    assert.equal(result.parameters[kind].support, "unsupported");
  assert.match(result.parameters.quality.reason!, /low/);
  assert.match(result.parameters.background.reason!, /transparent/);
  assert.match(result.parameters.input_references.reason!, /3 images/);
});

test("image diagnostics isolate provider combination conflicts and dimensional mismatches", () => {
  const endpoints = [
    {
      resolution: { type: "enum", values: ["1K"] },
      quality: { type: "enum", values: ["high"] },
      background: { type: "enum", values: ["opaque"] },
    },
    {
      resolution: { type: "enum", values: ["2K"] },
      quality: { type: "enum", values: ["low"] },
      background: { type: "enum", values: ["opaque"] },
    },
  ];
  const result = imageSettingsSupport(endpoints, {
    size: "2K",
    quality: "high",
    background: "opaque",
  });
  assert.equal(result.support, "unsupported");
  assert.equal(result.parameters.size.support, "unsupported");
  assert.equal(result.parameters.quality.support, "unsupported");
  assert.equal(result.parameters.background.support, "supported");
  assert.match(result.parameters.size.reason!, /2K.*high/);
  const mismatch = imageSettingsSupport(undefined, {
    size: "1536x1024",
    aspect_ratio: "1:1",
  });
  assert.equal(mismatch.parameters.size.support, "unsupported");
  assert.equal(mismatch.parameters.aspect_ratio.support, "unsupported");
  assert.match(mismatch.parameters.aspect_ratio.reason!, /1536x1024.*1:1/);
  const unknown = imageSettingsSupport(undefined, { quality: "high" });
  assert.equal(unknown.parameters.quality.support, "unknown");
});
