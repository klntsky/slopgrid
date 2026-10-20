import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { parseArgs, quote } from "../lib/common.mjs";
import { commands, parseCommandLine, showHelp } from "../lib/cli-options.mjs";

const source = dirname(dirname(fileURLToPath(import.meta.url)));

function unconfiguredCli(t) {
  const root = mkdtempSync(join(tmpdir(), "ops-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "ops"),
    bin = join(root, "bin"),
    touched = join(root, "infrastructure-called");
  mkdirSync(tools);
  mkdirSync(bin);
  for (const file of ["deploy.sh", "cli.mjs", "lib"])
    cpSync(join(source, file), join(tools, file), { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync("/bin/dirname", join(bin, "dirname"));
  for (const program of ["git", "ssh"])
    writeFileSync(
      join(bin, program),
      `#!/bin/sh\nprintf called > ${quote(touched)}\nexit 99\n`,
      { mode: 0o700 },
    );
  return {
    root,
    touched,
    run: (args) =>
      spawnSync("/bin/bash", [join(tools, "deploy.sh"), ...args], {
        cwd: root,
        env: { PATH: bin, HOME: root },
        encoding: "utf8",
        timeout: 5000,
      }),
  };
}

test("strict parsing rejects unknown flags, missing values and extra positionals", () => {
  for (const args of [
    ["staging", "--unknown"],
    ["staging", "--mode"],
    ["staging", "--mode="],
    ["staging", "--unit", "--plan"],
    ["staging", "--plan=false"],
    ["staging", "HEAD", "extra"],
    ["staging", "--", "--plan"],
    ["staging", "--unit=--skip-tests"],
    ["unknown"],
    [],
  ])
    assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
  for (const args of [
    ["help", "missing"],
    ["help", "rehearse", "extra"],
    ["help", "--plan"],
    ["status"],
    ["status", "../run"],
    ["status", "run", "extra"],
    ["status", "run", "--plan"],
    ["--plan"],
    ["--help", "--unknown"],
  ])
    assert.throws(
      () => parseCommandLine(args),
      undefined,
      JSON.stringify(args),
    );
  assert.equal(
    parseCommandLine(["status", "20261020-ab12"]).argument,
    "20261020-ab12",
  );
});

test("parser preserves validation, production, scoped-test and path safety policies", () => {
  for (const args of [
    ["validate", "--skip-tests"],
    ["validate", "--mode=soft"],
    ["rehearse", "--mode=auto"],
    ["rehearse", "--mode=machinery"],
    ["production", "--unit=tests/a.test.ts"],
    ["production", "--browser=tests/a.spec.ts"],
    ["staging", "--skip-tests", "--unit=tests/a.test.ts"],
    ["staging", "--grep=case"],
    ["staging", "--suite=invalid"],
    ["staging", "--mode=invalid"],
    ["staging", "--unit=tests/../secret.test.ts"],
    ["staging", "--browser=/tmp/case.spec.ts"],
  ])
    assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
  assert.equal(parseArgs(["production", "HEAD~2"]).tests, "full");
  assert.equal(parseArgs(["production", "--skip-tests"]).tests, "skip");
  assert.equal(parseArgs(["rehearse", "--skip-tests"]).tests, "skip");
});

test("grid discard and failed-start recovery remain staging-only and reject soft mode", () => {
  const first = "a".repeat(48),
    second = "b".repeat(48);
  const result = parseArgs([
    "staging",
    `--discard-grid=${first}`,
    "--discard-grid",
    second,
    "--recover-failed-start",
  ]);
  assert.deepEqual(result.discardGrids, [first, second]);
  assert.equal(result.recoverFailedStart, true);
  for (const target of ["validate", "rehearse", "production"])
    for (const flag of [`--discard-grid=${first}`, "--recover-failed-start"])
      assert.throws(() => parseArgs([target, flag]));
  for (const flags of [
    [`--discard-grid=${first}`, "--mode=soft"],
    ["--recover-failed-start", "--mode=soft"],
    [`--discard-grid=${first}`, `--discard-grid=${first}`],
    ["--discard-grid=not-an-id"],
  ])
    assert.throws(() => parseArgs(["staging", ...flags]));
});

test("standalone shell help works without config, Git or SSH and never writes runtime state", (t) => {
  const f = unconfiguredCli(t);
  for (const args of [
    [],
    ["--help"],
    ["-h"],
    ...Object.keys(commands).flatMap((name) => [
      ["help", name],
      [name, "--help"],
    ]),
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    if (args[0] === "help")
      assert.ok(result.stdout.includes(`./deploy.sh ${args[1]} `));
    assert.doesNotMatch(result.stdout, /Help topic \(/);
    assert.equal(existsSync(f.touched), false);
  }
  const production = f.run(["help", "production"]).stdout;
  assert.match(production, /master/);
  assert.doesNotMatch(
    production,
    /--discard-grid|--recover-failed-start|--unit FILE/,
  );
  assert.deepEqual(readdirSync(f.root).sort(), ["bin", "ops"]);
});

test("invalid shell arguments fail before configuration or infrastructure access", (t) => {
  const f = unconfiguredCli(t);
  for (const args of [
    ["staging", "--unknown"],
    ["staging", "--mode"],
    ["production", "--unit=tests/a.test.ts"],
    ["status", "run", "extra"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.doesNotMatch(result.stderr, /Missing or invalid config/);
    assert.equal(existsSync(f.touched), false);
  }
});

test(
  "interactive TTY help selects a command, handles unknown topics and exits",
  { timeout: 5000 },
  async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    const choices = ["unknown", "rehearse", "q"];
    const pages = [];
    let prompts = 0;
    output.on("data", (chunk) => {
      if (chunk.toString().startsWith("Usage:\n")) pages.push(chunk.toString());
      if (chunk.toString().startsWith("\nHelp topic (")) {
        const choice = choices[prompts++];
        setImmediate(() => input.write(`${choice}\n`));
      }
    });
    try {
      await showHelp(undefined, { input, output });
      assert.ok(pages[1].includes("./deploy.sh rehearse [REV]"));
      assert.doesNotMatch(pages[1], /\.\/deploy\.sh (production|status) /);
    } finally {
      input.destroy();
      output.destroy();
    }
  },
);
