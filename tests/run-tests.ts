import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCommands } from "./test-commands.js";

const { values } = parseArgs({
  options: {
    "reuse-build": { type: "boolean", default: false },
    unit: { type: "string", multiple: true, default: [] },
    browser: { type: "string", multiple: true, default: [] },
    suite: { type: "string", default: "all" },
    grep: { type: "string" },
  },
});
if (!["all", "mock", "real"].includes(values.suite))
  throw new Error("Use --suite all, mock, or real");
if (!values["reuse-build"]) {
  const code = await runCommands([["pnpm", "build"]]);
  if (code) process.exit(code);
}
const scoped = values.unit.length > 0 || values.browser.length > 0;
const units = scoped
  ? values.unit
  : readdirSync("tests")
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => `tests/${name}`);
const commands: string[][] = [];
if (units.length)
  commands.push([
    "pnpm",
    "exec",
    "tsx",
    "--test",
    "--test-concurrency=4",
    ...units,
  ]);
if (!scoped || values.browser.length)
  commands.push([
    "pnpm",
    "exec",
    "tsx",
    "tests/run-e2e.ts",
    "--reuse-build",
    "--suite",
    values.suite,
    ...values.browser,
    ...(values.grep ? ["--grep", values.grep] : []),
  ]);
process.exitCode = await runCommands(commands);
