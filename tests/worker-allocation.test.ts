import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWorker } from "../server/worker-allocation.js";

test("fair selection respects user ceilings, shared capacity, and eligibility", () => {
  const owners = new Map([
    ["alice", { limit: 3, last: 2 }],
    ["bob", { limit: 1, last: 1 }],
    ["carol", { limit: 2, last: 0 }],
  ]);
  const choose = (running: string[], candidates = [...owners.keys()]) =>
    selectWorker(owners, candidates, running, 4);
  assert.equal(choose([]), "carol");
  assert.equal(choose([], ["alice", "bob"]), "bob");
  assert.equal(choose(["alice", "alice", "bob"]), "carol");
  assert.equal(choose(["bob"], ["alice", "bob"]), "alice");
  assert.equal(choose(["bob"], ["bob"]), undefined);
  assert.equal(choose(["alice", "alice", "bob", "carol"]), undefined);
  assert.equal(choose([], []), undefined);
  owners.get("alice")!.limit = 1;
  assert.equal(choose(["alice", "alice"], ["alice"]), undefined);
  owners.get("alice")!.limit = 3;
  assert.equal(choose(["alice", "alice"], ["alice"]), "alice");
});
