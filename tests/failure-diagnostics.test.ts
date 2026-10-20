import { test } from "node:test";
import assert from "node:assert/strict";
import { failureDiagnostics } from "../server/failures.js";
import { runtimeFixture, until } from "./runtime-fixture.js";
import { storedCellInferenceFailure } from "./billing-storage-fixture.js";

test("diagnostics retain bounded cause codes without serializing private error payloads", () => {
  const cause = Object.assign(new Error("private output"), {
    code: "UND_ERR_SOCKET",
    socket: { remoteAddress: "private address" },
  });
  const error = Object.assign(new Error("private prompt", { cause }), {
    statusCode: 200,
    isRetryable: false,
    requestBodyValues: { prompt: "private prompt" },
    responseHeaders: { authorization: "private credential" },
    responseBody: "private output",
  });
  Object.assign(cause, { cause: error });
  assert.deepEqual(failureDiagnostics(error), [
    { name: "Error", statusCode: 200, isRetryable: false },
    { name: "Error", code: "UND_ERR_SOCKET" },
  ]);
  let deep: unknown = new Error("private");
  for (let i = 0; i < 20; i++)
    deep = Object.assign(new Error("private", { cause: deep }), {
      code: `CAUSE_${i}`,
    });
  assert.deepEqual(
    failureDiagnostics(deep),
    Array.from({ length: 8 }, (_, index) => ({
      name: "Error",
      code: `CAUSE_${19 - index}`,
    })),
  );
});

test(
  "an interrupted provider stream persists its underlying transport failure privately across restart",
  { timeout: 20000 },
  async () => {
    const f = await runtimeFixture();
    try {
      const grid = f.grid({
        rows: { kind: "variable", values: [[{ text: "cat" }]] },
      });
      await f.engine.api.startGrid({ gridId: grid.id, sessionId: f.owner });
      const call = await f.call(0);
      call.write({ content: "Partial output" });
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => !!g.cells[0].draft,
      );
      call.disconnect();
      await until(
        () => f.engine.api.getGrid(grid.id),
        (g) => g.cells[0].status === "error",
      );
      const read = () =>
        storedCellInferenceFailure(f.store.db, grid.cells[0].id);
      const saved = read();
      assert.equal(saved.status, "failed");
      assert.equal(saved.httpStatus, 200);
      assert.ok(
        saved.diagnostics.some(
          (cause: { code?: string }) => cause.code === "UND_ERR_SOCKET",
        ),
      );
      assert.equal(f.calls.length, 1);
      assert.ok(!("diagnostics" in f.store.billing.page(f.owner, 0).calls[0]));
      assert.ok(!JSON.stringify(saved.diagnostics).includes("Partial output"));
      await f.engine.close();
      await f.startEngine();
      assert.deepEqual(read().diagnostics, saved.diagnostics);
    } finally {
      await f.close();
    }
  },
);
