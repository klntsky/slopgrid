import { test } from "node:test";
import assert from "node:assert/strict";
import { PartialWebsite } from "../server/partial-website.js";

test("website entries stream escaped contents and tolerate either property order", () => {
  const preview = new PartialWebsite();
  let response = '{"files":[{"path":"index.html","content":"<h1>Growing';
  preview.update(response);
  assert.equal(preview.files["index.html"], "<h1>Growing");
  response +=
    '</h1>\\n"},{"content":"body { color: red; }","path":"style.css"},{"path":"app.js","content":"const title = \\"Live\\"; // \\u00';
  preview.update(response);
  assert.equal(preview.files["style.css"], "body { color: red; }");
  assert.equal(preview.files["app.js"], 'const title = "Live"; // ');
  response += 'e9"},{"path":"../private","content":"blocked"}]}';
  preview.update(response);
  assert.equal(preview.files["app.js"], 'const title = "Live"; // é');
  assert.equal(preview.files["../private"], undefined);
  assert.equal(preview.files["index.html"], "<h1>Growing</h1>\n");
});
