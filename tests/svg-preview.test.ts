import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSvg } from "../shared/svg.js";

const completeSvgPreview = prepareSvg;

const root = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">';

test("streaming across namespace and fence boundaries keeps one complete namespace", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
  const response = `\`\`\`svg\n${svg}\n\`\`\``;
  for (let end = 0; end <= response.length; end++) {
    const draft = response.slice(0, end);
    const preview = completeSvgPreview(draft);
    if (!draft.includes("<svg")) {
      assert.ok(!preview.includes("<svg"));
      continue;
    }
    assert.ok(preview, `No preview at character ${end}`);
    assert.match(preview, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
    assert.equal((preview.match(/xmlns=/g) ?? []).length, 1);
    assert.ok(preview.trimEnd().endsWith("</svg>"));
    assert.ok(!preview.includes("```"));
  }
  assert.equal(completeSvgPreview(response), svg);
});

test("streamed SVG previews close nested elements without changing complete markup", () => {
  const draft = `${root}<g><text x="10">hello`;
  assert.equal(completeSvgPreview(draft), `${draft}</text></g></svg>`);
  const complete = `${root}<g><path d="M0 0 L20 20" /></g></svg>`;
  assert.equal(completeSvgPreview(complete), complete);
  assert.equal(completeSvgPreview(`\`\`\`svg\n${complete}\n\`\`\``), complete);
  assert.equal(
    completeSvgPreview("Still thinking about the drawing"),
    "Still thinking about the drawing",
  );
});

test("unfinished paths and attributes render while split closing tags stay balanced", () => {
  assert.equal(
    completeSvgPreview(`${root}<g><path d="M0 0 L20 20`),
    `${root}<g><path d="M0 0 L20 20"></path></g></svg>`,
  );
  assert.equal(
    completeSvgPreview(`${root}<rect width="20" fill=`),
    `${root}<rect width="20"></rect></svg>`,
  );
  assert.equal(
    completeSvgPreview(`${root}<g><circle r="20"/></g`),
    `${root}<g><circle r="20"/></g></svg>`,
  );
  assert.equal(
    completeSvgPreview('<svg viewBox="0 0 200 200"><g'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g></g></svg>',
  );
});

test("quoted delimiters, entities, comments and CDATA do not corrupt the closing stack", () => {
  assert.equal(
    completeSvgPreview(`${root}<g data-label="a > b"><text>fish &am`),
    `${root}<g data-label="a > b"><text>fish &am</text></g></svg>`,
  );
  assert.equal(
    completeSvgPreview(`${root}<text><![CDATA[a < b]]></text><!-- <g> -->`),
    `${root}<text><![CDATA[a < b]]></text><!-- <g> --></svg>`,
  );
});
