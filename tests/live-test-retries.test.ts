import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { validationEnvironment } = require("../ops/lib/validate.mjs");
const playwright = require.resolve("@playwright/test");
const cli = require.resolve("@playwright/test/cli");
const config = fileURLToPath(
  new URL("../playwright.config.ts", import.meta.url),
);
const root = fileURLToPath(new URL("..", import.meta.url));

const scenarios = [
  {
    name: "direct live tests retain a single attempt",
    deployment: false,
    project: "real",
    success: 2,
    status: 1,
    attempts: [0],
  },
  {
    name: "deployment live tests can succeed on their third attempt",
    deployment: true,
    project: "real",
    success: 2,
    status: 0,
    attempts: [0, 1, 2],
  },
  {
    name: "deployment live tests fail after exactly three attempts",
    deployment: true,
    project: "real",
    success: -1,
    status: 1,
    attempts: [0, 1, 2],
  },
  {
    name: "successful deployment live tests are not repeated",
    deployment: true,
    project: "real",
    success: 0,
    status: 0,
    attempts: [0],
  },
  {
    name: "deployment mock tests retain a single attempt",
    deployment: true,
    project: "mock",
    success: 2,
    status: 1,
    attempts: [0],
  },
  {
    name: "deployment GitHub tests retain a single attempt",
    deployment: true,
    project: "github",
    success: 2,
    status: 1,
    attempts: [0],
  },
];

for (const scenario of scenarios) {
  test(scenario.name, { timeout: 60000 }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "slopgrid-live-retries-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const runtime = join(directory, "runtime");
    mkdirSync(runtime);
    const journal = join(directory, "attempts.jsonl");
    writeFileSync(journal, "");
    writeFileSync(
      join(directory, "attempt.spec.ts"),
      `
import { test, expect } from ${JSON.stringify(playwright)};
import { appendFileSync } from "node:fs";
test("controlled live-model failure", async ({}, info) => {
  appendFileSync(process.env.ATTEMPT_JOURNAL!, JSON.stringify(info.retry) + "\\n");
  expect(info.retry).toBe(Number(process.env.SUCCESS_AT_RETRY));
});
`,
    );
    const candidateConfig = join(directory, "playwright.config.ts");
    writeFileSync(
      candidateConfig,
      `
import config from ${JSON.stringify(config)};
export default {
  ...config,
  reporter: "line",
  outputDir: ${JSON.stringify(join(directory, "results"))},
  projects: config.projects?.map(project => ({ ...project, testDir: ${JSON.stringify(directory)}, testMatch: "attempt.spec.ts" })),
};
`,
    );
    const inherited = { ...process.env };
    delete inherited.SLOPGRID_REAL_TEST_RETRIES;
    const env = scenario.deployment
      ? validationEnvironment(
          directory,
          runtime,
          { SLOPGRID_REAL_TEST_RETRIES: "9" },
          { ...inherited, SLOPGRID_REAL_TEST_RETRIES: "8" },
        )
      : inherited;
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "test",
        "--config",
        candidateConfig,
        `--project=${scenario.project}`,
        "--workers=1",
      ],
      {
        cwd: root,
        env: {
          ...env,
          ATTEMPT_JOURNAL: journal,
          SUCCESS_AT_RETRY: String(scenario.success),
        },
        encoding: "utf8",
        timeout: 45000,
      },
    );
    assert.equal(result.status, scenario.status, result.stdout + result.stderr);
    const attempts = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map(Number);
    assert.deepEqual(attempts, scenario.attempts);
  });
}
