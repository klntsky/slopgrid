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
  assert.equal(map.follow(100, 200, 0), 200);
});

test("short-area focus movement pauses the receiver rather than reversing it", () => {
  const map = buildScrollMap(
    { limit: 1500, anchors: [0, 1000, 1000, 2000] },
    { limit: 1300, anchors: [0, 200, 200, 1800] },
  );
  assert.equal(map.follow(100, 200, 50), 0);
  assert.equal(map.follow(200, 100, -50), 0);
  assert.equal(map.follow(100, 200, 10), 10);
  assert.equal(map.follow(200, 100, -10), -10);
  assert.equal(map.follow(900, 1100, 100), 110);
  assert.equal(map.follow(1100, 900, -100), -110);
});

test("continuation resumes from the paused position without a reversal catch-up", () => {
  const map = buildScrollMap(
    { limit: 1500, anchors: [0, 1000, 1000, 2000] },
    { limit: 1300, anchors: [0, 200, 200, 1800] },
  );
  let receiver = 400;
  receiver += map.follow(100, 200, 50);
  assert.equal(receiver, 400);
  receiver += map.follow(200, 300, 0);
  assert.equal(receiver, 420);
  receiver += map.follow(300, 200, -50);
  assert.equal(receiver, 420);
  receiver += map.follow(200, 100, 0);
  assert.equal(receiver, 400);
});

test("coalesced and subdivided linear focus paths agree across real area boundaries", () => {
  const map = buildScrollMap(
    { limit: 1500, anchors: [0, 1000, 1000, 2000] },
    { limit: 1300, anchors: [0, 200, 200, 1800] },
  );
  const coalesced = map.follow(800, 1800, 500);
  const subdivided =
    map.follow(800, 900, 50) +
    map.follow(900, 1000, 50) +
    map.follow(1000, 1050, 25) +
    map.follow(1050, 1300, 125) +
    map.follow(1300, 1800, 250);
  assert.equal(coalesced, 880);
  assert.equal(subdivided, coalesced);
  const reversed =
    map.follow(1800, 1300, -250) +
    map.follow(1300, 1050, -125) +
    map.follow(1050, 1000, -25) +
    map.follow(1000, 900, -50) +
    map.follow(900, 800, -50);
  assert.equal(map.follow(1800, 800, -500), -880);
  assert.equal(reversed, -coalesced);
});

test("fixed-focus native movement follows ordinary mapped displacement in both directions", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [100, 1100, 1200, 1300] },
    { limit: 200, anchors: [50, 550, 750, 1250] },
  );
  assert.equal(map.follow(600, 1250, 0), 700);
  assert.equal(map.follow(1250, 600, 0), -700);
  assert.equal(map.follow(-100, 2000, 0), 1200);
  assert.equal(map.follow(2000, -100, 0), -1200);
  assert.equal(map.follow(-100, 0, 0), 0);
  assert.equal(map.follow(1500, 2000, 0), 0);
  assert.equal(map.follow(600, 600, 300), 0);
});

test("clamped prefixes and suffixes participate in focus movement without event dependence", () => {
  const map = buildScrollMap(
    { limit: 50, anchors: [100, 200] },
    { limit: 50, anchors: [300, 500] },
  );
  assert.equal(map.follow(0, 300, 150), 150);
  assert.equal(
    map.follow(0, 100, 50) +
      map.follow(100, 200, 50) +
      map.follow(200, 300, 50),
    150,
  );
  assert.equal(map.follow(300, 0, -150), -150);
  assert.equal(map.follow(0, 300, -150), 350);
  assert.equal(
    map.follow(0, 100, -50) +
      map.follow(100, 200, -50) +
      map.follow(200, 300, -50),
    350,
  );
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
  assert.equal(map.follow(0, 160, 0), 230);
  assert.equal(map.follow(160, 0, 0), -230);
});

test("collapsed target areas pause and continue at their exact boundary", () => {
  const map = buildScrollMap(
    { limit: 100, anchors: [0, 100, 100, 200] },
    { limit: 100, anchors: [0, 0, 0, 100] },
  );
  assert.equal(map.project(50), 0);
  assert.equal(map.project(100), 0);
  assert.equal(map.project(150), 50);
  assert.equal(map.follow(50, 150, 20), 40);
  assert.equal(map.follow(150, 50, -20), -40);
  assert.equal(map.follow(50, 100, 10) + map.follow(100, 150, 10), 40);
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
  assert.equal(map.follow(0, 1000, 0), 10);
  assert.equal(map.follow(1000, 0, 0), -10);
  const reversed = buildScrollMap(
    { limit: 2000, anchors: [30, 40] },
    { limit: 1000, anchors: [10, 20, 40, 50] },
  );
  assert.equal(reversed.project(35), 15);
  assert.equal(reversed.project(2000), 20);
});

test("empty or entirely collapsed common spans cannot produce following movement", () => {
  const empty = buildScrollMap(
    { limit: 100, anchors: [10, 20] },
    { limit: 200, anchors: [] },
  );
  assert.equal(empty.project(100), 0);
  assert.equal(empty.follow(0, 100, -50), 0);
  const singleton = buildScrollMap(
    { limit: 100, anchors: [10] },
    { limit: 200, anchors: [30, 40] },
  );
  assert.equal(singleton.project(-100), 30);
  assert.equal(singleton.project(100), 30);
  assert.equal(singleton.follow(0, 100, -50), 0);
  const collapsed = buildScrollMap(
    { limit: 100, anchors: [10, 10] },
    { limit: 200, anchors: [30, 40] },
  );
  assert.equal(collapsed.project(10), 40);
  assert.equal(collapsed.follow(0, 100, -50), 0);
});
