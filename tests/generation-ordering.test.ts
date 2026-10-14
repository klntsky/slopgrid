import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture, kill } from "./runtime-fixture.js";
import { queryClient } from "../src/queries.js";

test("snapshot reads are ordered without writes, and replacement engines supersede even settled snapshots", async () => {
  const f = await runtimeFixture();
  try {
    const grid = f.grid();
    const first = await f.engine.api.getGrid(grid.id);
    assert.ok(
      first.version,
      "snapshots carry an engine epoch and read sequence",
    );
    const databaseVersion = f.store.db.pragma("data_version", { simple: true });
    let latest = first;
    for (let read = 0; read < 20; read++) {
      const next = await f.engine.api.getGrid(grid.id);
      assert.equal(next.version.epoch, first.version.epoch);
      assert.ok(next.version.sequence > latest.version.sequence);
      latest = next;
    }
    assert.equal(
      f.store.db.pragma("data_version", { simple: true }),
      databaseVersion,
    );
    await kill(f.web);
    await f.startWeb();
    assert.equal(
      (await f.engine.api.getGrid(grid.id)).version.epoch,
      first.version.epoch,
      "web replacement must not allocate a new engine epoch",
    );
    f.store.setTitle(grid.id, "Edited while settled");
    const edited = await f.engine.api.getGrid(grid.id);
    assert.equal(edited.title, "Edited while settled");
    assert.ok(edited.version.sequence > latest.version.sequence);
    for (let restart = 0; restart < 2; restart++) {
      await f.engine.close();
      await f.startEngine();
      const fresh = await f.engine.api.getGrid(grid.id);
      assert.ok(fresh.version.epoch > latest.version.epoch);
      assert.equal(fresh.live, false);
      assert.equal(fresh.title, edited.title);
      queryClient.setQueryData(["grid", grid.id], fresh);
      queryClient.setQueryData(["grid", grid.id], {
        ...latest,
        version: { ...latest.version, sequence: Number.MAX_SAFE_INTEGER },
      });
      assert.equal(queryClient.getQueryData(["grid", grid.id]), fresh);
      latest = fresh;
    }
    assert.equal(f.calls.length, 0);
  } finally {
    queryClient.clear();
    await f.close();
  }
});
