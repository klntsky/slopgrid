import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../server/output-format.js";

test("static bundles keep relative assets and reject unsafe files", () => {
  const bundle = (files: Record<string, string>) =>
    JSON.stringify({
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    });
  assert.deepEqual(
    parseOutput(
      "html",
      bundle({
        "index.html": '<link href="style.css">',
        "style.css": "body{color:red}",
        "assets/app.js": "console.log(1)",
        "assets/module.mjs": "export default 1",
        "server.php": "<?php echo 'stored, never executed'; ?>",
        "api.ts": "const value: number = 1;",
        LICENSE: "license text",
      }),
    ),
    {
      "index.html": '<link href="style.css">',
      "style.css": "body{color:red}",
      "assets/app.js": "console.log(1)",
      "assets/module.mjs": "export default 1",
      "server.php": "<?php echo 'stored, never executed'; ?>",
      "api.ts": "const value: number = 1;",
      LICENSE: "license text",
    },
  );
  for (const path of ["../secret", "/index.html", "a/../../x", "a\\x", "a//x"])
    assert.throws(() =>
      parseOutput("html", bundle({ "index.html": "ok", [path]: "bad" })),
    );
  assert.throws(() => parseOutput("html", bundle({ "style.css": "" })));
  assert.throws(() => parseOutput("html", '{"files":'));
  assert.throws(
    () =>
      parseOutput(
        "html",
        "```json\n" + bundle({ "index.html": "ok" }) + "\n```",
      ),
    SyntaxError,
  );
});

test("website output rejects duplicate paths and schema violations", () => {
  for (const files of [
    [
      { path: "index.html", content: "a" },
      { path: "index.html", content: "b" },
    ],
    [{ path: "index.html", content: 42 }],
    [{ path: "index.html", content: "ok", extra: true }],
  ])
    assert.throws(() => parseOutput("html", JSON.stringify({ files })));
});
