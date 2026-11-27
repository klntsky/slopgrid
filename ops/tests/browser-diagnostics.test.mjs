import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validationEnvironment } from "../lib/validate.mjs";

const application = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const playwright = pathToFileURL(createRequire(import.meta.url).resolve("@playwright/test")).href;
const execute = promisify(execFile);

test("browser failure artifacts survive validation runtime cleanup while successful runs leave none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "slopgrid-browser-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts");
  const specs = join(root, "specs");
  await mkdir(specs);
  const config = join(root, "playwright.config.mjs");
  await writeFile(config, `export default ${JSON.stringify({
    testDir: specs,
    workers: 1,
    reporter: "list",
    projects: [{ name: "mock" }],
    use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  })};`);
  await writeFile(join(specs, "diagnostics.spec.mjs"), `
import playwright from ${JSON.stringify(playwright)};
const { test, expect } = playwright;
test("browser diagnostics", async ({ page }) => {
  await page.goto("data:text/html,<h1>Captured browser state</h1>");
  await expect(page.getByRole("heading")).toHaveText(process.env.EXPECTED_HEADING, { timeout: 100 });
});
`);
  for (const failed of [true, false]) {
    const runtime = await mkdtemp(join(root, "runtime-"));
    const env = validationEnvironment(application, runtime, {}, {
      ...process.env,
      SLOPGRID_E2E_ARTIFACTS_DIR: artifacts,
      EXPECTED_HEADING: failed ? "Controlled failure" : "Captured browser state",
    });
    let result;
    try {
      result = await execute(process.execPath, [
        "--import", "tsx", "tests/run-e2e.ts", "--suite", "mock", "--reuse-build", "--config", config,
      ], { cwd: application, env, maxBuffer: 1024 * 1024 });
    } catch (error) {
      result = error;
    }
    await rm(runtime, { recursive: true, force: true });
    if (failed) {
      assert.equal(result.code, 1);
      const retained = result.stderr.match(/Browser failure artifacts retained at (.+)/)?.[1];
      assert.ok(retained, result.stdout + result.stderr);
      assert.ok(retained.startsWith(artifacts + "/"));
      const entries = await readdir(retained, { recursive: true });
      assert.ok(entries.some((entry) => entry.endsWith("trace.zip")));
      assert.ok(entries.some((entry) => entry.endsWith("test-failed-1.png")));
      const context = entries.find((entry) => entry.endsWith("error-context.md"));
      assert.ok(context);
      assert.match(await readFile(join(retained, context), "utf8"), /Captured browser state/);
      await rm(retained, { recursive: true, force: true });
    } else {
      assert.equal(result.code, undefined, result.stdout + result.stderr);
      assert.deepEqual(await readdir(artifacts), []);
    }
  }
});
