import { test } from "node:test";
import assert from "node:assert/strict";
import { parseE2EPort } from "./e2e-port.js";

test("browser ports require explicit nonblank configuration", () => {
  for (const value of [undefined, "", " ", "\t\n"])
    assert.throws(() => parseE2EPort(value), /E2E_PORT is required/);
});

test("browser ports reject invalid numbers and reserved or out-of-range ports", () => {
  for (const value of [
    "invalid",
    "NaN",
    "Infinity",
    "-1",
    "1",
    "1023",
    "65536",
    "3000.5",
    "9007199254740992",
  ])
    assert.throws(() => parseE2EPort(value), /Invalid E2E_PORT/);
});

test("browser ports allow explicit OS-assigned and fixed ports", () => {
  assert.equal(parseE2EPort("0"), 0);
  assert.equal(parseE2EPort("1024"), 1024);
  assert.equal(parseE2EPort(" 3000 "), 3000);
  assert.equal(parseE2EPort("65535"), 65535);
});
