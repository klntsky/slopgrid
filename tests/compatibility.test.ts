import { test } from "node:test";
import assert from "node:assert/strict";
import {
  thinkingEffortSupport,
  imageSettingsSupport,
} from "../server/compatibility.js";
import type { Model } from "../server/provider.js";

const models: Model[] = [
  {
    id: "required",
    name: "Required thinker",
    image: false,
    text: true,
    reasoning: true,
    reasoningMandatory: true,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "plain",
    name: "Plain model",
    image: false,
    text: true,
    reasoning: false,
    reasoningMandatory: false,
    reasoningEfforts: ["none"],
  },
  {
    id: "fixed",
    name: "Fixed thinker",
    image: false,
    text: true,
    reasoning: true,
    reasoningMandatory: true,
    reasoningEfforts: [],
  },
  {
    id: "router",
    name: "Dynamic router",
    image: false,
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
