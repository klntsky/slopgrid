import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScrollMap } from "../src/grid/scroll-map.js";

test("whole-history landmarks stay continuous when a short item enters the viewport", () => {
  const map = buildScrollMap(
    { limit: 1300, anchors: [0, 1000, 1000, 1100, 1100, 1600] },
    { limit: 1600, anchors: [0, 500, 500, 1000, 1000, 2000] },
  );
  assert.equal(map(799), 399.5);
  assert.equal(map(801), 400.5);
  assert.equal(map(1050), 750);
  assert.equal(map(0), 0);
  assert.equal(map(1300), 1600);
  assert.equal(map(-10), 0);
  assert.equal(map(1400), 1600);
});

test("collapsed landmarks produce a continuous monotone map with native endpoints", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [0, 0, 20, 20, 100, 160] },
    { limit: 200, anchors: [0, 10, 40, 80, 180, 240] },
  );
  assert.equal(map(0), 0);
  assert.equal(map(100), 200);
  let previous = map(0);
  for (let x = 0.25; x <= 100; x += 0.25) {
    const next = map(x);
    assert.ok(Number.isFinite(next) && next >= previous && next <= 200);
    previous = next;
  }
  assert.ok(map(20.001) - map(19.999) < 0.1);
});

test("short receiver scroll ranges plateau instead of overshooting or reversing", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [20, 50, 80] },
    { limit: 60, anchors: [20, 100, 200] },
  );
  assert.equal(map(10), 10);
  assert.equal(map(50), 60);
  assert.equal(map(75), 60);
  assert.equal(map(100), 60);
});

test("non-scrollable panels remain fixed and partial histories retain their matched prefix", () => {
  assert.equal(
    buildScrollMap({ limit: 0, anchors: [] }, { limit: 100, anchors: [20] })(0),
    0,
  );
  assert.equal(
    buildScrollMap(
      { limit: 100, anchors: [20] },
      { limit: 0, anchors: [] },
    )(50),
    0,
  );
  const map = buildScrollMap(
    { limit: 100, anchors: [10, 20, 40, 50] },
    { limit: 100, anchors: [30, 40] },
  );
  assert.equal(map(15), 35);
  assert.equal(map(100), 100);
});
