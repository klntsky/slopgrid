import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  command,
  capture,
  shell,
  quote,
  sha256,
  parseArgs,
  assertProductionRevision,
} from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log(`Usage:
  ./deploy.sh validate [REV] [--unit FILE --browser FILE]
  ./deploy.sh staging [REV] [--skip-tests | --unit FILE --browser FILE] [--mode auto|soft|machinery] [--discard-grid ID] [--recover-failed-start]
  ./deploy.sh production [REV] [--skip-tests] [--mode auto|soft|machinery]
  ./deploy.sh validate|staging|production [REV] --plan
  ./deploy.sh status RUN_ID

The default validation is the complete suite in an isolated per-run workspace.
Use validate for independent worktree candidates without changing any runtime.
Production accepts only the authoritative master tip and promotes only production.
Repeat --unit or --browser for more files; --suite mock|real and --grep PATTERN
select browsers. Production never changes staging.
Repeat --discard-grid to delete selected staging grids after draining and backup,
before migration. Deletion forces machinery mode and is rejected for production.
Use --recover-failed-start only to recover an unpromoted staging engine that
failed before readiness. Recovery requires runtime safety checks, forces machinery
mode, and cannot be combined with --mode soft or used for production.
The command waits for completion and returns the remote exit status. Work runs
in remote tmux bg and survives an SSH disconnect. --plan changes nothing.
Config: OPS_* values in the application repository root .env (environment overrides allowed).`);
  process.exit(0);
}
process.umask(0o077);
try {
  const config = loadConfig();
  const remote = (words) => capture("ssh", [config.host, shell(words)]);
  const remoteNode = (words) => [
    "env",
    `PATH=${config.nodePath}`,
    "node",
    ...words,
  ];
  if (args[0] === "status") {
    const id = args[1];
    if (!/^[a-zA-Z0-9-]+$/.test(id ?? "") || args.length !== 2)
      throw new Error("Invalid run ID");
    const run = join(config.remoteRoot, "runs", id);
    const request = JSON.parse(remote(["cat", join(run, "request.json")]));
    await follow(remote, remoteNode, request.tools, run);
  } else {
    // Prefer the invoking application worktree, never an unrelated checkout.
    const caller = spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (caller.status === 0) {
      const [common, checkout] = caller.stdout.trim().split("\n");
      const configuredCommon = capture("git", [
        "-C", config.repository, "rev-parse", "--path-format=absolute", "--git-common-dir",
      ]);
      if (realpathSync(common) === realpathSync(configuredCommon))
        config.repository = checkout;
    }
    const options = parseArgs([...args]);
    const revision = capture("git", [
      "-C",
      config.repository,
      "rev-parse",
      "--verify",
      `${options.revision}^{commit}`,
    ]);
    if (!/^[a-f0-9]{40}$/.test(revision))
      throw new Error("Invalid application revision");
    assertProductionRevision({ ...options, revision, config });
    const opsRevision = capture("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const operationsRepository = capture("git", [
      "-C", root, "rev-parse", "--show-toplevel",
    ]);
    const tools = join(config.remoteRoot, "tools", opsRevision);
    if (options.plan) {
      console.log(
        JSON.stringify(
          {
            revision,
            opsRevision,
            target: options.target,
            validation: options.tests,
            stages: [
              "build in isolated run",
              "validate in isolated run",
              ...(options.target === "validate" ? [] : [`deploy ${options.target}`]),
            ],
            mode: options.mode,
            discardGrids: options.discardGrids,
            recoverFailedStart: options.recoverFailedStart,
            config: { host: config.host, remoteRoot: config.remoteRoot },
            note: "No files uploaded or runtime processes changed. Production plans query authoritative master. Auto mode compares engine dependencies at deployment time.",
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    for (const directory of [config.repository, root])
      if (
        capture("git", [
          "-C",
          directory,
          "status",
          "--porcelain",
          "--untracked-files=no",
        ])
      )
        throw new Error(`Commit changes before deploying: ${directory}`);
    const archive = (directory, tree) => {
      const result = spawnSync(
        "git",
        [
          "-C",
          directory,
          "archive",
          "--format=tar.gz",
          tree,
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      if (result.status !== 0)
        throw new Error("Could not archive committed source");
      return result.stdout;
    };
    const source = archive(config.repository, revision),
      implementation = archive(operationsRepository, `${opsRevision}:ops`);
    const id = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomBytes(4).toString("hex")}`;
    const run = join(config.remoteRoot, "runs", id);
    remote(["mkdir", "-p", run, dirname(tools)]);
    const upload = (path, content) =>
      command("ssh", [config.host, `umask 077; cat > ${quote(path)}`], {
        input: content,
        stdio: ["pipe", "inherit", "inherit"],
      });
    upload(join(run, "tools.tar.gz"), implementation);
    const incoming = tools + "-" + id;
    remote(["mkdir", "-p", incoming]);
    remote(["tar", "-xzf", join(run, "tools.tar.gz"), "-C", incoming]);
    remote([
      "bash",
      "-c",
      `if test -d ${quote(tools)}; then diff -qr ${quote(incoming)} ${quote(tools)} && rm -rf ${quote(incoming)}; else mv ${quote(incoming)} ${quote(tools)}; fi`,
    ]);
    upload(join(run, "source.tar.gz"), source);
    upload(
      join(run, "request.json"),
      JSON.stringify({
        ...options,
        revision,
        opsRevision,
        tools,
        id,
        sourceHash: sha256(source),
        config,
      }),
    );
    remote([
      "bash",
      "-c",
      "tmux has-session -t bg 2>/dev/null || tmux new-session -d -s bg",
    ]);
    const window = remote([
      "tmux",
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      "bg",
      "-n",
      `deploy-${options.target}-${id}`,
      shell([
        "env",
        `PATH=${config.nodePath}`,
        "bash",
        join(tools, "remote-run.sh"),
        run,
        config.remoteRoot,
      ]),
    ]);
    console.log(
      `Run ${id} started in remote tmux bg (${window}). Log: ${run}/run.log`,
    );
    console.log(`Reconnect with: ./deploy.sh status ${id}`);
    await follow(remote, remoteNode, tools, run);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function follow(remote, remoteNode, tools, run) {
  let offset = 0;
  for (;;) {
    const state = JSON.parse(
      remote(remoteNode([join(tools, "lib/status.mjs"), run, String(offset)])),
    );
    if (state.log) process.stdout.write(state.log);
    offset = state.offset;
    if (state.exit !== null) {
      process.exitCode = state.exit;
      return;
    }
    if (state.orphaned)
      throw new Error(
        `Deployment worker is no longer running. Inspect ${run}; do not assume deployment succeeded.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
