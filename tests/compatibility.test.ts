import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compatibilityIssues,
  thinkingEffortSupport,
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
test("every incompatible model and effort is named once, with supported alternatives", () => {
  const issues = compatibilityIssues(
    [
      { model: "required", effort: "none" },
      { model: "required", effort: "max" },
      { model: "plain", effort: "high" },
      { model: "plain", effort: "high" },
    ],
    "svg",
    models,
  );
  assert.equal(issues.length, 3);
  assert.match(
    issues[0],
    /Required thinker.*required.*requires thinking.*None/,
  );
  assert.match(issues[1], /Required thinker.*max.*low.*high/);
  assert.match(issues[2], /Plain model.*high.*None/);
  assert.deepEqual(
    compatibilityIssues(
      [
        { model: "required", effort: "high" },
        { model: "plain", effort: "none" },
      ],
      "svg",
      models,
    ),
    [],
  );
});
test("model defaults remain valid when effort selection is unavailable or routing is unknown", () => {
  assert.deepEqual(
    compatibilityIssues(
      models.map((m) => ({ model: m.id, effort: "default" })),
      "markdown",
      models,
    ),
    [],
  );
  assert.match(
    compatibilityIssues([{ model: "fixed", effort: "low" }], "svg", models)[0],
    /Fixed thinker.*does not expose thinking-effort selection.*low.*Model default/,
  );
  assert.match(
    compatibilityIssues(
      [{ model: "router", effort: "high" }],
      "svg",
      models,
    )[0],
    /Dynamic router.*verify.*high.*Model default/,
  );
});
test("unavailable models and incompatible output formats are checked too", () => {
  assert.match(
    compatibilityIssues(
      [{ model: "missing", effort: "default" }],
      "svg",
      models,
    )[0],
    /missing.*unavailable/,
  );
  assert.match(
    compatibilityIssues(
      [{ model: "plain", effort: "none" }],
      "image",
      models,
    )[0],
    /Plain model.*image/,
  );
});
