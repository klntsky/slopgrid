import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAliasWarnings } from "../src/create/model-alias-warnings.js";
import { Provider } from "../server/provider.js";

test("catalog metadata supplies selected moving-alias warnings without changing the selected ID", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        {
          id: "fixture/chat-latest",
          canonical_slug: "fixture/chat-latest-20260505",
        },
        { id: "fixture/version", canonical_slug: "fixture/version-20260505" },
        {
          id: "~fixture/latest",
          canonical_slug: "~fixture/latest",
          alias_target: { slug: "fixture/version" },
        },
      ].map((model) => ({
        ...model,
        name: model.id,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
      })),
    }),
  );
  const models = await new Provider().models();
  assert.equal(models[0].canonicalSlug, "fixture/chat-latest-20260505");
  for (const others of [[], ["fixture/version", "~fixture/latest"]]) {
    const render = (values: string[]) =>
      renderToStaticMarkup(
        createElement(ModelAliasWarnings, {
          models,
          values,
        }),
      );
    assert.doesNotMatch(render([]), /data-model-alias-warning/);
    assert.doesNotMatch(
      render(["fixture/version", "~fixture/latest"]),
      /data-model-alias-warning/,
    );
    const selected = render([...others, "fixture/chat-latest"]);
    assert.match(selected, /data-model-alias-warning="fixture\/chat-latest"/);
    assert.match(selected, /fixture\/chat-latest-20260505/);
    assert.doesNotMatch(render([]), /data-model-alias-warning/);
  }
});
