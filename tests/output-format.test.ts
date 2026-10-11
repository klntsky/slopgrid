import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../server/output-format.js";

test("Markdown preserves code fences and indentation verbatim", () => {
  for (const markdown of [
    "```text\n    /\\\n   /  \\\n  /____\\\n```\n\nA paragraph after the drawing.\n",
    "    first indented line\n    second indented line\n",
  ])
    assert.equal(parseOutput("markdown", markdown)["index.md"], markdown);
});

for (const structured of [false, true])
  test(`static bundles (${structured ? "structured" : "prompted"}) keep relative assets and reject unsafe files`, () => {
    const bundle = (files: Record<string, string>) =>
      JSON.stringify({
        files: structured
          ? Object.entries(files).map(([path, content]) => ({ path, content }))
          : files,
      });
    assert.deepEqual(
      parseOutput(
        "html",
        bundle({
          "index.html": '<link href="style.css">',
          "style.css": "body{color:red}",
          "assets/app.js": "console.log(1)",
        }),
        structured,
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
          bundle({ "index.html": "ok", [path]: "bad" }),
          structured,
        ),
      );
    assert.throws(() =>
      parseOutput("html", bundle({ "style.css": "" }), structured),
    );
    assert.throws(() => parseOutput("html", '{"files":', structured));
  });

test("structured website output rejects duplicate paths and schema violations", () => {
  for (const files of [
    [
      { path: "index.html", content: "a" },
      { path: "index.html", content: "b" },
    ],
    [{ path: "index.html", content: 42 }],
    [{ path: "index.html", content: "ok", extra: true }],
  ])
    assert.throws(() => parseOutput("html", JSON.stringify({ files }), true));
});
