import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { prepareLocalCandidate } from "./lib/local.mjs";
import {
  command,
  capture,
  shell,
  quote,
  sha256,
  deploymentOptions,
  assertProductionRevision,
} from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";
import { parseCommandLine, showHelp } from "./lib/cli-options.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
process.umask(0o077);
async function main() {
  const invocation = parseCommandLine(args);
  if (invocation.help) {
    await showHelp(invocation.target);
    return;
  }
  const options =
    invocation.target === "status" ? null : deploymentOptions(invocation);
  const config = loadConfig();
  const remote = (words) => capture("ssh", [config.host, shell(words)]);
  const remoteNode = (words) => [
    "env",
    `PATH=${config.nodePath}`,
    "node",
    ...words,
  ];
  if (invocation.target === "status") {
    const id = invocation.argument;
    const run = join(config.remoteRoot, "runs", id);
    const request = JSON.parse(remote(["cat", join(run, "request.json")]));
    await follow(remote, remoteNode, request.tools, run);
  } else {
    // Prefer the invoking application worktree, never an unrelated checkout.
    const caller = spawnSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (caller.status === 0) {
      const [common, checkout] = caller.stdout.trim().split("\n");
      const configuredCommon = capture("git", [
        "-C",
        config.repository,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (realpathSync(common) === realpathSync(configuredCommon))
        config.repository = checkout;
    }
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
      "-C",
      root,
      "rev-parse",
      "--show-toplevel",
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
              "build committed candidate and run test suites locally in isolation",
              ...(options.target === "production" ||
              options.target === "rehearse"
                ? [
                    "copy production SQLite backup and all outputs into private workspace",
                    "run candidate Store migrations and check database integrity",
                  ]
                : ["validate fresh data in isolated run"]),
              options.tests === "skip"
                ? "skip test suites explicitly"
                : `run ${options.tests} test suites locally`,
              ...(["validate", "rehearse"].includes(options.target)
                ? []
                : [`deploy ${options.target}`]),
            ],
            mode: options.mode,
            discardGrids: options.discardGrids,
            recoverFailedStart: options.recoverFailedStart,
            config: { host: config.host, remoteRoot: config.remoteRoot },
            note: ["validate", "rehearse"].includes(options.target)
              ? "No deployment lock, persistent runtime preparation, promotion or PM2 operations. Plan uploads no files and changes no runtime processes."
              : "No files uploaded or runtime processes changed. Production plans query authoritative master. Auto mode compares engine dependencies at deployment time.",
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
        ["-C", directory, "archive", "--format=tar.gz", tree],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      if (result.status !== 0)
        throw new Error("Could not archive committed source");
      return result.stdout;
    };
    const source = archive(config.repository, revision),
      implementation = archive(operationsRepository, `${opsRevision}:ops`);
    const local = await prepareLocalCandidate(
      {
        ...options,
        revision,
        opsRevision,
        sourceHash: sha256(source),
      },
      source,
    );
    try {
      if (options.target === "validate") return;
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
      upload(join(run, "frontend.tar.gz"), local.frontend);
      upload(
        join(run, "request.json"),
        JSON.stringify({
          ...options,
          revision,
          opsRevision,
          tools,
          id,
          sourceHash: sha256(source),
          frontendHash: local.frontendHash,
          localValidation: local.validation,
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
    } finally {
      rmSync(local.run, { recursive: true, force: true });
    }
  }
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

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
