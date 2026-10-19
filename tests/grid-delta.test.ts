import assert from "node:assert/strict";
import test from "node:test";
import { applyDelta, gridDelta } from "../shared/grid-delta.js";

test("stream deltas append text without repeating existing content or unchanged cells", () => {
  const prefix = "existing thinking ".repeat(10000);
  const before = {
    cells: [{ thinking: prefix, draft: "a" }, { prompt: prefix }],
  };
  const after = {
    cells: [{ thinking: prefix + "new", draft: "answer" }, { prompt: prefix }],
  };
  const delta = gridDelta(before, after)!;
  assert.ok(JSON.stringify(delta).length < 250);
  assert.deepEqual(applyDelta(before, delta), after);
  assert.equal(before.cells[0].thinking, prefix);
});

test("deltas preserve resets, removals, nulls, array changes and nested judgment results", () => {
  const states = [
    {
      cells: [
        { draft: "old", thinking: "trace", judge: { status: "running" } },
      ],
    },
    {
      cells: [
        { draft: "", judge: { status: "complete", results: [true, false] } },
      ],
    },
    { cells: [{ draft: "fresh", judge: null }, { draft: "second" }] },
  ];
  for (let i = 1; i < states.length; i++) {
    assert.deepEqual(
      applyDelta(states[i - 1], gridDelta(states[i - 1], states[i])!),
      states[i],
    );
  }
  assert.equal(gridDelta(states[0], structuredClone(states[0])), undefined);
});
