import { test } from "node:test";
import assert from "node:assert/strict";
import { createHtmlHosts } from "../server/hosts.js";
const id = "a".repeat(48);

test("HTML hosts share one DNS level and use a valid CSP wildcard", () => {
  const hosts = createHtmlHosts(
    new URL("https://app.example.com"),
    "-grid.example.com",
  );
  assert.equal(hosts.url(id), `https://${id}-grid.example.com/index.html`);
  assert.equal(hosts.cellId(`${id}-grid.example.com`), id);
  assert.equal(hosts.frameSource, "https://*.example.com");
  for (const invalid of [
    `${id}.grid.example.com`,
    `${id}-grid.example.com.evil.test`,
    `short-grid.example.com`,
    `extra.${id}-grid.example.com`,
  ])
    assert.equal(hosts.cellId(invalid), undefined);
});

test("HTML hosts use the same single-label format with a development port", () => {
  const hosts = createHtmlHosts(
    new URL("http://localhost:4317"),
    "-grid.localhost:4317",
  );
  assert.equal(hosts.url(id), `http://${id}-grid.localhost:4317/index.html`);
  assert.equal(hosts.cellId(`${id}-grid.localhost:4317`), id);
  assert.equal(hosts.frameSource, "http://*.localhost:4317");
  assert.equal(hosts.cellId(`${id}-grid.localhost:4318`), undefined);
});

test("HTML suffixes reject invalid DNS names and overlapping application hosts", () => {
  for (const suffix of [
    "grid.example.com",
    "-{id}.example.com",
    "-this-label-is-too-long.example.com",
    "-grid.example.com/path",
    "-grid.example.com@evil.test",
    "-grid.bad..example.com",
    "-localhost",
  ])
    assert.throws(() =>
      createHtmlHosts(new URL("https://app.example.com"), suffix),
    );
  assert.throws(() =>
    createHtmlHosts(
      new URL(`https://${id}-grid.example.com`),
      "-grid.example.com",
    ),
  );
});
