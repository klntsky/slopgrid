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
import { deploymentOptions, parseArgs, quote } from "../lib/common.mjs";
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
    bin,
    touched,
    run: (args, environment = {}) =>
      spawnSync("/bin/bash", [join(tools, "deploy.sh"), ...args], {
        cwd: root,
        env: { PATH: bin, HOME: root, ...environment },
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
    ["production", "--grep=case"],
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
  assert.equal(parseArgs(["production", "--suite=real"]).suite, "real");
  assert.equal(parseArgs(["validate", "--mode=auto"]).mode, "auto");
  assert.equal(parseArgs(["staging"]).revision, "HEAD");
  assert.equal(parseArgs(["validate"]).target, "validate");
  const invocation = parseCommandLine(["staging", "release/next", "--plan"]);
  assert.equal(deploymentOptions(invocation).revision, "release/next");
  assert.equal(deploymentOptions(invocation).plan, true);
});

test("demo rejects persistent deployment and invalid validation options", () => {
  for (const flags of [
    ["--mode=auto"], ["--mode=soft"], ["--mode=machinery"],
    ["--recover-failed-start"], [`--discard-grid=${"a".repeat(48)}`],
    ["--ttl=5"], ["--skip-tests", "--unit=tests/a.test.ts"],
    ["--grep=case"], ["--unit=tests/../secret.test.ts"],
  ]) assert.throws(() => parseArgs(["demo", ...flags]), undefined, flags.join(" "));
});

test("demo reuse accepts only a safe local run ID and remains absent on fresh requests", () => {
  const id = "20261023180248349-NCchax";
  assert.equal(parseArgs(["demo", "feature", "--reuse-demo", id, "--skip-tests"]).reuseDemo, id);
  assert.equal(Object.hasOwn(parseArgs(["demo"]), "reuseDemo"), false);
  for (const target of ["validate", "rehearse", "staging", "production"])
    assert.throws(() => parseArgs([target, "--reuse-demo", id]), /only permitted on demo/);
  assert.throws(() => parseCommandLine(["status", "run", "--reuse-demo", id]), /Status does not accept/);
  for (const value of ["", "../run", "/run", "a/b", "a.b", "-run", "a\\nb", "x".repeat(129)])
    assert.throws(() => parseArgs(["demo", `--reuse-demo=${value}`]), /argument|run ID/i);
  assert.throws(() => parseArgs(["demo", "--reuse-demo"]), /argument/i);
});

test("HTTPS listener override is demo-only and accepts only real TCP ports", () => {
  assert.equal(parseArgs(["demo", "--https-port=8446"]).httpsPort, 8446);
  assert.equal(Object.hasOwn(parseArgs(["demo"]), "httpsPort"), false);
  for (const target of ["validate", "rehearse", "staging", "production"])
    assert.throws(() => parseArgs([target, "--https-port=8446"]), /only permitted on demo/);
  for (const value of ["0", "65536", "-1", "1.5", "abc", "1e3"])
    assert.throws(() => parseArgs(["demo", `--https-port=${value}`]), /HTTPS port/);
});

test("demo reuse plans leave source and runtime state untouched", (t) => {
  const f = unconfiguredCli(t);
  writeFileSync(join(f.bin, "git"), `#!${process.execPath}
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (args.includes("--show-toplevel")) process.exit(1);
    if (!args.includes("--verify")) { writeFileSync(${JSON.stringify(f.touched)}, "unexpected git mutation"); process.exit(99); }
    process.stdout.write("${"a".repeat(40)}\\n");
  `, { mode: 0o700 });
  const stateRoot = join(f.root, "never-created-demos");
  const result = f.run(["demo", "feature", "--reuse-demo=stopped-run", "--https-port=8446", "--skip-tests", "--plan"], {
    OPS_DEMO_STATE_ROOT: stateRoot,
    OPS_DEMO_ENV_FILE: join(f.root, "never-read.env"),
    OPS_DEMO_HTTPS_PORT: "8445",
    OPS_HOST: "fixture.invalid",
    OPS_NODE_PATH: "/usr/bin:/bin",
    OPS_STAGING_ENV_FILE: join(f.root, "never-read-staging.env"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(stateRoot), false);
  assert.equal(existsSync(f.touched), false);
  assert.deepEqual(readdirSync(f.root).sort(), ["bin", "ops"]);
});

test("demo shell help is available without configuration or infrastructure", (t) => {
  const f = unconfiguredCli(t);
  for (const args of [["help", "demo"], ["demo", "--help"]]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.\/deploy\.sh demo \[REV\]/);
    assert.match(result.stdout, /--reuse-demo RUN_ID/);
    assert.match(result.stdout, /--https-port PORT/);
    assert.doesNotMatch(result.stdout, /--mode |--discard-grid|--recover-failed-start|--ttl/);
  }
  assert.equal(existsSync(f.touched), false);
  assert.deepEqual(readdirSync(f.root).sort(), ["bin", "ops"]);
});

test("grid discard and failed-start recovery remain staging-only and reject soft mode", () => {
  for (const target of ["staging", "production"])
    assert.equal(parseArgs([target]).recoverFailedStart, false);
  for (const mode of ["auto", "machinery"])
    assert.equal(
      parseArgs(["staging", "--recover-failed-start", `--mode=${mode}`])
        .recoverFailedStart,
      true,
    );
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
    ["--recover-failed-start", "--skip-tests", "--unit=tests/a.test.ts"],
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
