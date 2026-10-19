import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScrollMap } from "../src/grid/scroll-map.js";

test("projection exactly interpolates full areas and their intervening gaps", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [100, 1100, 1200, 1300, 1300, 1800] },
    { limit: 200, anchors: [50, 550, 750, 1250, 1250, 2250] },
  );
  assert.equal(map.project(100), 50);
  assert.equal(map.project(600), 300);
  assert.equal(map.project(1100), 550);
  assert.equal(map.project(1150), 650);
  assert.equal(map.project(1200), 750);
  assert.equal(map.project(1250), 1000);
  assert.equal(map.project(1300), 1250);
  assert.equal(map.project(1550), 1750);
  assert.equal(map.project(1800), 2250);
  assert.ok(map.project(1300.001) - map.project(1299.999) < 0.01);
});

test("projection clamps only at matched content boundaries, not native scroll limits", () => {
  const map = buildScrollMap(
    { limit: 0, anchors: [100, 200] },
    { limit: 0, anchors: [300, 500] },
  );
  assert.equal(map.project(-100), 300);
  assert.equal(map.project(0), 300);
  assert.equal(map.project(150), 400);
  assert.equal(map.project(1000), 500);
});

test("collapsed source boundaries have continuous monotone endpoint ownership", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [0, 0, 20, 20, 100, 160] },
    { limit: 200, anchors: [0, 10, 40, 80, 180, 240] },
  );
  assert.equal(map.project(-10), 10);
  assert.equal(map.project(0), 10);
  assert.equal(map.project(10), 45);
  assert.equal(map.project(20), 80);
  assert.equal(map.project(60), 130);
  assert.equal(map.project(160), 240);
  assert.equal(map.project(200), 240);
  let previous = map.project(0);
  for (let point = 0.25; point <= 160; point += 0.25) {
    const next = map.project(point);
    assert.ok(Number.isFinite(next) && next >= previous && next <= 240);
    previous = next;
  }
  assert.ok(map.project(20.001) - map.project(19.999) < 0.01);
});

test("collapsed target areas project to a fixed point throughout the area", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [0, 100, 100, 200] },
    { limit: 100, anchors: [0, 0, 0, 100] },
  );
  assert.equal(map.project(50), 0);
  assert.equal(map.project(100), 0);
  assert.equal(map.project(150), 50);
});

test("partial histories retain only their common matched prefix", () => {
  const map = buildScrollMap(
    { limit: 1000, anchors: [10, 20, 40, 50] },
    { limit: 2000, anchors: [30, 40] },
  );
  assert.equal(map.project(0), 30);
  assert.equal(map.project(15), 35);
  assert.equal(map.project(20), 40);
  assert.equal(map.project(1000), 40);
  const reversed = buildScrollMap(
    { limit: 2000, anchors: [30, 40] },
    { limit: 1000, anchors: [10, 20, 40, 50] },
  );
  assert.equal(reversed.project(35), 15);
  assert.equal(reversed.project(2000), 20);
});

test("empty and collapsed common spans project to their shared endpoint", () => {
  const empty = buildScrollMap(
    { limit: 100, anchors: [10, 20] },
    { limit: 200, anchors: [] },
  );
  assert.equal(empty.project(100), 0);
  const singleton = buildScrollMap(
    { limit: 100, anchors: [10] },
    { limit: 200, anchors: [30, 40] },
  );
  assert.equal(singleton.project(-100), 30);
  assert.equal(singleton.project(100), 30);
  const collapsed = buildScrollMap(
    { limit: 100, anchors: [10, 10] },
    { limit: 200, anchors: [30, 40] },
  );
  assert.equal(collapsed.project(10), 40);
});
