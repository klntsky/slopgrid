import { test } from "node:test";
import assert from "node:assert/strict";
import { PartialWebsite } from "../server/partial-website.js";

test("website files become available before their JSON strings finish, with escapes decoded across chunks", () => {
  const preview = new PartialWebsite();
  let response = '{"files":{"index.html":"<h1>Growing';
  preview.update(response);
  assert.equal(preview.files["index.html"], "<h1>Growing");
  response += '</h1>\\n","style.css":"body { color: red; }';
  preview.update(response);
  assert.equal(preview.files["index.html"], "<h1>Growing</h1>\n");
  assert.equal(preview.files["style.css"], "body { color: red; }");
  response += '","app.js":"const title = \\"Live\\"; // \\u00';
  preview.update(response);
  assert.equal(preview.files["app.js"], 'const title = "Live"; // ');
  response += 'e9"}}';
  preview.update(response);
  assert.deepEqual({ ...preview.files }, JSON.parse(response).files);
});
