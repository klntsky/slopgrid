import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingEffortSupport } from "../server/compatibility.js";
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
