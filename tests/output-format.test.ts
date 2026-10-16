import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../server/output-format.js";

test("SVG output unwraps one enclosing Markdown code block", () => {
  // DeepSeek, Gemini, and Ministral shared this wrapper failure.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg">\n  <circle r="1"/>\n</svg>';
  for (const [opening, closing] of [
    ["```svg", "```"],
    ["```xml", "```"],
    ["```", "```"],
    ["~~~~svg", "~~~~~"],
    ["````SVG", "`````"],
  ]) {
    for (const newline of ["\n", "\r\n"]) {
      const content = svg.replaceAll("\n", newline);
      const raw = ` \n${opening}${newline}${content}${newline}${closing}\n `;
      assert.deepEqual(parseOutput("svg", raw), { "index.svg": content });
      assert.deepEqual(parseOutput("markdown", raw), { "index.md": raw });
    }
  }
});

test("SVG fixup preserves source outside a single complete wrapper", () => {
  for (const raw of [
    " \n<svg><text>```svg</text></svg>\n ",
    "```svg\n<svg/>",
    "```svg\n<svg/>\n~~~",
    "````svg\n<svg/>\n```",
    "Here is the SVG:\n```svg\n<svg/>\n```",
    "```svg\n<svg/>\n```\nExplanation",
    "```svg\n<svg/>\n```\n```svg\n<svg/>\n```",
  ])
    assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves a missing namespace instead of repairing markup", () => {
  // Reduced from the small-model probe; fence removal does not fix namespaces.
  const raw = '<svg><circle r="1"/></svg>';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves an unclosed root instead of completing markup", () => {
  // Reduced from a provider response that ended normally without </svg>.
  const raw = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/>';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves an unescaped ampersand inside a fenced document", () => {
  // Reduced from Ministral: removing the fence must not rewrite text nodes.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>&</text></svg>';
  assert.deepEqual(parseOutput("svg", `\`\`\`xml\n${svg}\n\`\`\``), {
    "index.svg": svg,
  });
});

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
