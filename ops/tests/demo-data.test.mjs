import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoDataFixture, outputBytes, retainedSession, stagingKey } from "./demo-data-fixture.mjs";

function successful(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("required staging clone rejects a missing source before acquisition or runtime creation", (t) => {
  const f = demoDataFixture(t);
  const result = f.run("clone", "runtime", null);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /staging.*source|source.*required/i);
  assert.equal(existsSync(join(f.destinations, "runtime")), false);
  assert.deepEqual(readdirSync(f.destinations), []);
  assert.deepEqual(f.acquired(), []);
});

for (const [fault, message] of [
  ["unavailable", /unavailable|acquir|transport/i],
  ["missing-database", /reject|snapshot/i],
  ["unsafe-archive", /archive|reject/i],
  ["incompatible", /incompatible|candidate/i],
  ["wrong-key", /incompatible|candidate/i],
]) test(`required staging clone refuses ${fault} without publishing fresh replacement data`, (t) => {
  const f = demoDataFixture(t, fault);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /remote-private-error|private-staging-api-key/);
  assert.equal(existsSync(join(f.destinations, "runtime")), false);
  assert.deepEqual(readdirSync(f.destinations), []);
  assert.deepEqual(f.acquired(), ["snapshot"]);
});

test("required staging clone accepts real canonical storage and independently retains records, outputs and encryption key", (t) => {
  const f = demoDataFixture(t);
  const seed = successful(f.run());
  assert.equal(seed.kind, "imported");
  assert.equal(seed.key, stagingKey);
  const runtime = join(f.destinations, "runtime");
  const state = f.inspect(runtime, seed.key);
  assert.deepEqual(state.sessions, [retainedSession]);
  assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
  assert.deepEqual(state.foreignKeys, []);
  const output = join(runtime, "outputs/nested/artifact.bin");
  assert.deepEqual(readFileSync(output), outputBytes);
  for (const path of ["slopgrid.sqlite", "outputs/nested/artifact.bin"])
    assert.notEqual(statSync(join(runtime, path)).ino, statSync(join(f.staging, path)).ino);
  writeFileSync(output, "demo-only change");
  assert.deepEqual(readFileSync(join(f.staging, "outputs/nested/artifact.bin")), outputBytes);
  assert.deepEqual(f.inspect(f.staging, stagingKey).sessions, [retainedSession]);
  assert.deepEqual(f.acquired(), ["snapshot"]);
  assert.deepEqual(readdirSync(f.destinations), ["runtime"]);
});

test("explicit fresh selection initializes real canonical empty Stores with independent keys and never acquires staging data", (t) => {
  const f = demoDataFixture(t, "unavailable");
  const first = successful(f.run("fresh", "first"));
  const second = successful(f.run("fresh", "second"));
  for (const [name, seed] of [["first", first], ["second", second]]) {
    assert.equal(seed.kind, "skipped");
    assert.equal(seed.reason, "explicit-opt-out");
    assert.match(seed.key, /^[a-f0-9]{64}$/);
    assert.notEqual(seed.key, stagingKey);
    const runtime = join(f.destinations, name);
    const state = f.inspect(runtime, seed.key);
    assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.grids, []);
    assert.deepEqual(state.integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(state.foreignKeys, []);
    assert.equal(existsSync(join(runtime, "outputs/nested/artifact.bin")), false);
    assert.equal(statSync(join(runtime, "outputs")).isDirectory(), true);
  }
  assert.notEqual(first.key, second.key);
  assert.deepEqual(f.acquired(), []);
  assert.deepEqual(f.inspect(f.staging, stagingKey).sessions, [retainedSession]);
  assert.deepEqual(readFileSync(join(f.staging, "outputs/nested/artifact.bin")), outputBytes);
  assert.deepEqual(readdirSync(f.destinations).sort(), ["first", "second"]);
});
