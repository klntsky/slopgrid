import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../server/output-format.js";

test("static bundles keep relative assets and reject traversal and executable server files", () => {
  assert.deepEqual(
    parseOutput(
      "html",
      JSON.stringify({
        files: {
          "index.html": '<link href="style.css">',
          "style.css": "body{color:red}",
          "assets/app.js": "console.log(1)",
        },
      }),
    ),
    {
      "index.html": '<link href="style.css">',
      "style.css": "body{color:red}",
      "assets/app.js": "console.log(1)",
    },
  );
  for (const path of [
    "../secret",
    "/index.html",
    "a/../../x",
    "server.php",
    "a\\x",
    "a//x",
    "api.ts",
  ])
    assert.throws(() =>
      parseOutput(
        "html",
        JSON.stringify({ files: { "index.html": "ok", [path]: "bad" } }),
      ),
    );
  assert.throws(() => parseOutput("html", '{"files":{"style.css":""}}'));
});
