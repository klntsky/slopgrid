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

test("website previews retain the first non-conflicting path and keep streaming", () => {
  for (const paths of [
    ["assets", "assets/js/app.js"],
    ["assets/js/app.js", "assets"],
  ]) {
    const preview = new PartialWebsite();
    const source = JSON.stringify({
      files: [
        { path: paths[0], content: "first asset" },
        { content: "conflicting asset", path: paths[1] },
        { path: "assets-other", content: "separate asset" },
        { path: "index.html", content: "<h1>Still streaming</h1>" },
      ],
    });
    for (let length = 1; length <= source.length; length++)
      preview.update(source.slice(0, length));
    assert.equal(preview.files[paths[0]], "first asset");
    assert.equal(preview.files[paths[1]], undefined);
    assert.equal(preview.files["assets-other"], "separate asset");
    assert.equal(preview.files["index.html"], "<h1>Still streaming</h1>");
  }
});

test("superseded paths without content do not block streaming files", () => {
  // JSON object properties can repeat; final parsing uses the last path.
  for (const [superseded, path] of [
    ["index.html/page.html", "index.html"],
    ["assets/app.js", "assets"],
    ["assets", "assets/app.js"],
  ]) {
    const preview = new PartialWebsite();
    const source =
      `{"files":[{"path":${JSON.stringify(superseded)},` +
      `"path":${JSON.stringify(path)},"content":"Growing`;
    for (let length = 1; length <= source.length; length++)
      preview.update(source.slice(0, length));
    assert.equal(preview.files[path], "Growing");
    assert.equal(preview.files[superseded], undefined);
    preview.update(source + ' page"}]}');
    assert.equal(preview.files[path], "Growing page");
  }
});
