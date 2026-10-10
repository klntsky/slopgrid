import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutputHosts } from "../server/hosts.js";
const id = "a".repeat(48);

test("hyphenated output hosts share one DNS level and use a valid CSP wildcard", () => {
  const hosts = createOutputHosts(
    new URL("https://app.example.com"),
    "{id}-grid.example.com",
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

test("subdomain output hosts and development ports remain supported", () => {
  const hosts = createOutputHosts(
    new URL("http://localhost:4317"),
    "{id}.user.localhost:4317",
  );
  assert.equal(hosts.url(id), `http://${id}.user.localhost:4317/index.html`);
  assert.equal(hosts.cellId(`${id}.user.localhost:4317`), id);
  assert.equal(hosts.frameSource, "http://*.user.localhost:4317");
  assert.equal(hosts.cellId(`${id}.user.localhost:4318`), undefined);
});

test("output templates cannot overlap the app host or generate malformed DNS names", () => {
  for (const template of [
    "grid.example.com",
    "{id}-{id}.example.com",
    "{id}-this-label-is-too-long.example.com",
    "{id}.example.com/path",
    "{id}.example.com@evil.test",
    "{id}.bad..example.com",
    "{id}-localhost",
  ])
    assert.throws(() =>
      createOutputHosts(new URL("https://app.example.com"), template),
    );
  assert.throws(() =>
    createOutputHosts(
      new URL(`https://${id}-grid.example.com`),
      "{id}-grid.example.com",
    ),
  );
});
