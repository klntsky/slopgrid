import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Provider } from "../server/provider.js";
import { createModelCatalog } from "../server/model-catalog.js";
import { appFixture } from "./app-fixture.js";

test("catalog loads all details together and refreshes only on the server timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let version = "first";
  let calls = 0;
  let fail = false;
  let held: Promise<void> | undefined;
  let release = () => {};
  class CatalogProvider extends Provider {
    override async models() {
      calls++;
      await held;
      if (fail) throw new Error("Upstream unavailable");
      return ["text", "image-a", "image-b"].map((id) => ({
        id,
        name: version,
        image: id !== "text",
        imageInput: false,
        text: id === "text",
        reasoning: false,
        reasoningMandatory: false,
      }));
    }
    override async imageEndpoints() {
      return [
        {
          provider_name: "Fixture",
          supported_parameters: {},
          pricing: [
            {
              billable: "output_image",
              unit: "image",
              cost_usd: version === "first" ? 0.4 : 0.8,
            },
          ],
        },
      ];
    }
  }
  const catalog = createModelCatalog(new CatalogProvider());
  t.after(() => catalog.close());
  const loaded = await Promise.all(
    Array.from({ length: 20 }, () => catalog.read()),
  );
  const first = loaded[0];
  assert.ok(loaded.every((models) => models[0].name === "first"));
  assert.equal(calls, 1);
  assert.deepEqual(
    first
      .filter((model) => model.image)
      .map((model) => [
        model.id,
        model.imageEndpoints?.[0].pricing[0].cost_usd,
      ]),
    [
      ["image-a", 0.4],
      ["image-b", 0.4],
    ],
  );
  const changes: string[] = [];
  catalog.subscribe((models) => changes.push(models[0].name));
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.timers.tick(300000);
  assert.deepEqual(await catalog.read(), first);
  fail = true;
  release();
  await setImmediate();
  assert.deepEqual(await catalog.read(), first);
  assert.deepEqual(changes, ["first"]);
  held = undefined;
  fail = false;
  version = "second";
  t.mock.timers.tick(300000);
  await setImmediate();
  const refreshed = await catalog.read();
  assert.equal(refreshed[0].name, "second");
  assert.deepEqual(
    refreshed
      .filter((model) => model.image)
      .map((model) => model.imageEndpoints?.[0].pricing[0].cost_usd),
    [0.8, 0.8],
  );
  assert.deepEqual(changes, ["first", "second"]);
  catalog.close();
  version = "third";
  t.mock.timers.tick(300000);
  await setImmediate();
  assert.deepEqual(await catalog.read(), refreshed);
  assert.deepEqual(changes, ["first", "second"]);
});

test("model-list reads bypass exhausted API limits and do not consume the API allowance", async (t) => {
  class CatalogProvider extends Provider {
    override async models() {
      return [];
    }
  }
  const { origin } = await appFixture(t, { provider: new CatalogProvider() });
  for (let i = 0; i < 610; i++) {
    const response = await fetch(`${origin}/api/models`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  }
  for (let i = 0; i < 600; i++) {
    const response = await fetch(`${origin}/api/session`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const limited = await fetch(`${origin}/api/session`);
  assert.equal(limited.status, 429);
  await limited.arrayBuffer();
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${origin}/api/models`, { method });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});
