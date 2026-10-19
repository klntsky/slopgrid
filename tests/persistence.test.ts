import test from "node:test";
import assert from "node:assert/strict";
import { Persistence } from "../server/persistence.js";

test("storage retries preserve write order, cap backoff, reset after recovery and release waiters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0,
    blocked = true;
  const committed: number[] = [];
  const persistence = new Persistence();
  persistence.submit(
    () => {
      attempts++;
      if (blocked)
        throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
    },
    () => committed.push(1),
  );
  persistence.submit(
    () => {},
    () => committed.push(2),
  );
  const waiting = persistence.waitForWrites();
  const cancelled = new AbortController();
  const cancellation = assert.rejects(
    persistence.waitForWrites(cancelled.signal),
    { name: "AbortError" },
  );
  cancelled.abort();
  await cancellation;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = attempts;
    t.mock.timers.tick(delay - 1);
    assert.equal(attempts, before);
    t.mock.timers.tick(1);
    assert.equal(attempts, before + 1);
    assert.deepEqual(committed, []);
    assert.equal(persistence.status().pendingOperations, 2);
  }
  blocked = false;
  t.mock.timers.tick(30000);
  await waiting;
  assert.deepEqual(committed, [1, 2]);
  assert.equal(persistence.blocked, false);
  blocked = true;
  persistence.submit(() => {
    attempts++;
    if (blocked)
      throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
  });
  const before = attempts;
  t.mock.timers.tick(999);
  assert.equal(attempts, before);
  blocked = false;
  t.mock.timers.tick(1);
  assert.equal(attempts, before + 1);
  assert.equal(persistence.status().healthy, true);
});
