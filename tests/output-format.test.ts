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
    ' \n<svg xmlns="http://www.w3.org/2000/svg"><text>```svg</text></svg>\n ',
    "```svg\n<svg/>\n~~~",
    "Here is the SVG:\n```svg\n<svg/>\n```",
    "```svg\n<svg/>\n```\nExplanation",
    "```svg\n<svg/>\n```\n```svg\n<svg/>\n```",
  ])
    assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup adds a missing root namespace", () => {
  // Reduced from Llama and Gemma responses; retain only namespace edge cases.
  for (const [raw, expected] of [
    [
      '<svg><circle r="1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
    ],
    ["<svg/>", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["```svg\n<svg/>\n```", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    [
      ' \n<?xml version="1.0"?>\n<!-- <svg xmlns="example"/> -->\n<svg/>',
      ' \n<?xml version="1.0"?>\n<!-- <svg xmlns="example"/> -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    [
      "<svg data-note=\"xmlns='example' >\"/>",
      '<svg xmlns="http://www.w3.org/2000/svg" data-note="xmlns=\'example\' >"/>',
    ],
    [
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"/>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    ],
    [
      '<svg><g xmlns="http://www.w3.org/2000/svg"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/2000/svg"/></svg>',
    ],
  ]) {
    assert.deepEqual(parseOutput("svg", raw), { "index.svg": expected });
    assert.deepEqual(parseOutput("svg", expected), { "index.svg": expected });
    assert.deepEqual(parseOutput("markdown", raw), { "index.md": raw });
  }
});

test("SVG namespace fixup preserves existing declarations and non-root text", () => {
  for (const raw of [
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "<svg\n xmlns = 'http://www.w3.org/2000/svg' />",
    '<svg xmlns="other"/>',
    "<!-- <svg/> -->",
    "<html><svg/></html>",
    "<svgish/>",
  ])
    assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves backticks attached directly to markup", () => {
  // Reduced from Mistral Small: these are not complete Markdown fence lines.
  const raw = '```<svg xmlns="http://www.w3.org/2000/svg"/>```';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves malformed attribute quotes", () => {
  // Reduced from Llama's animation response with nested unescaped quotes.
  for (const raw of [
    '<svg xmlns="http://www.w3.org/2000/svg" style="opacity="1;"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g style="opacity="1;"/><circle r="1"/></svg>',
  ])
    assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup distinguishes shorter content fences from the outer fence", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text><![CDATA[\n```\n]]></text></svg>';
  assert.deepEqual(parseOutput("svg", `\`\`\`\`svg\n${svg}\n\`\`\`\``), {
    "index.svg": svg,
  });
});

test("SVG fixup retains text in an unfinished CDATA section", () => {
  const raw = '<svg xmlns="http://www.w3.org/2000/svg"><text><![CDATA[horse';
  assert.deepEqual(parseOutput("svg", raw), {
    "index.svg": raw + "]]></text></svg>",
  });
});

test("SVG fixup saves closing tags for an unclosed root", () => {
  // Reduced from a provider response that ended normally without </svg>.
  const raw = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/>';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw + "</svg>" });
});

test("SVG fixup does not replace an incompatible partial closing tag", () => {
  const raw = '<svg xmlns="http://www.w3.org/2000/svg"><g></path';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup preserves unsupported declarations instead of discarding later content", () => {
  const raw =
    '<svg xmlns="http://www.w3.org/2000/svg"><!unexpected><circle r="1"/></svg>';
  assert.deepEqual(parseOutput("svg", raw), { "index.svg": raw });
});

test("SVG fixup saves incomplete attribute and fence repairs", () => {
  const raw = '```svg\n<svg><path d="M0 0';
  assert.deepEqual(parseOutput("svg", raw), {
    "index.svg":
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"></path></svg>',
  });
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
