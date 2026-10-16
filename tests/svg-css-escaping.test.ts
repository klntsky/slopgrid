import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSvg } from "../shared/svg.js";
import { parseOutput } from "../server/output-format.js";

const root = '<svg xmlns="http://www.w3.org/2000/svg">';

test("bare CSS ampersands are escaped in previews and saved SVG without double escaping", () => {
  const raw = `${root}<style type="text/css">/* Horse Body & Global Bobbing */
.horse { fill: red; } /* Alert & Pushoff */</style>
<g><style>/* A&B && C &amp; D */ .x { fill: url("paint?a=1&b=2"); }</style></g></svg>`;
  const expected = `${root}<style type="text/css">/* Horse Body &amp; Global Bobbing */
.horse { fill: red; } /* Alert &amp; Pushoff */</style>
<g><style>/* A&amp;B &amp;&amp; C &amp; D */ .x { fill: url("paint?a=1&amp;b=2"); }</style></g></svg>`;
  assert.equal(prepareSvg(raw), expected);
  assert.equal(parseOutput("svg", raw)["index.svg"], expected);
  assert.equal(prepareSvg(expected), expected);
  assert.equal(parseOutput("markdown", raw)["index.md"], raw);
});

test("valid SVG entities, CDATA, comments, processing instructions and attributes remain byte-for-byte unchanged", () => {
  for (const content of [
    "<style>/* &amp; &lt; &gt; &quot; &apos; &#38; &#x26; &amp;amp; */</style>",
    '<style><![CDATA[/* A & B */ .x::before { content: "<style>&</style>"; }]]></style>',
    "<style>/* A &amp; B */<![CDATA[/* C & D */]]>/* E &#38; F */</style>",
    "<!-- <style>A & B</style> --><style><!-- C & D --></style>",
    "<?example <style>A & B</style>?><style><?example C & D?></style>",
    '<g data-note="&lt;style>A &amp; B&lt;/style>"><style data-note="x &amp; y > z">/* &amp; */</style></g>',
    "<style/><text>A &amp; B</text><style />",
    '<style>.x::after { content: "\\26 "; }</style>',
    "<text><![CDATA[<style>A & B</style>]]></text>",
    '<g xmlns="urn:other"><style>/* A &amp; B */</style></g>',
  ]) {
    const svg = `${root}${content}</svg>`;
    assert.equal(prepareSvg(svg), svg);
    assert.equal(parseOutput("svg", svg)["index.svg"], svg);
  }
  const declared = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY label "A &amp; B"><!ENTITY 名 "C">]>${root}<style>/* &label; &名; */</style></svg>`;
  assert.equal(prepareSvg(declared), declared);
});

test("CSS repair leaves XML literal regions and text outside styles alone", () => {
  const raw = `${root}<!-- <style>fake & style</style> --><style>/* A & B */<![CDATA[/* C & D */]]><!-- E & F --><?example G & H?>/* I & J */</style><text>outside & text</text><style data-note="attribute & value">/* K & L */</style></svg>`;
  const expected = `${root}<!-- <style>fake & style</style> --><style>/* A &amp; B */<![CDATA[/* C & D */]]><!-- E & F --><?example G & H?>/* I &amp; J */</style><text>outside & text</text><style data-note="attribute & value">/* K &amp; L */</style></svg>`;
  assert.equal(prepareSvg(raw), expected);
});

test("split entities and closing tags do not accumulate ampersand repairs", () => {
  const content = "/* A & B &amp; C &#38; D &#x26; */";
  const opening = `${root}<style>`;
  for (const [prefix, expected] of [
    ["/* A &", "/* A &amp;"],
    ["/* A & B &a", "/* A &amp; B &amp;a"],
    ["/* A & B &amp", "/* A &amp; B &amp;amp"],
    ["/* A & B &amp;", "/* A &amp; B &amp;"],
    ["/* A &#", "/* A &amp;#"],
    ["/* A &#38", "/* A &amp;#38"],
    ["/* A &#38;", "/* A &#38;"],
    ["/* A &#x", "/* A &amp;#x"],
    ["/* A &#x26", "/* A &amp;#x26"],
    ["/* A &#x26;", "/* A &#x26;"],
  ]) {
    assert.equal(
      prepareSvg(opening + prefix),
      opening + expected + "</style></svg>",
    );
  }
  const svg = `${opening}${content}</style></svg>`;
  const expected = `${opening}/* A &amp; B &amp; C &#38; D &#x26; */</style></svg>`;
  for (const end of ["</style", "</style>", "</style></svg", "</style></svg>"])
    assert.equal(prepareSvg(opening + content + end), expected);
  assert.equal(
    prepareSvg(`Here is the SVG:\n\`\`\`svg\n${svg}\n\`\`\``),
    expected,
  );
});

test("unsupported XML boundaries preserve the source rather than guessing", () => {
  for (const raw of [
    `${root}<style><![CDATA[/* A & B`,
    `${root}<style><!-- A & B`,
    `${root}<style><?example A & B`,
    `${root}<style>/* A & B */</g></svg>`,
  ])
    assert.equal(prepareSvg(raw), raw);
});
