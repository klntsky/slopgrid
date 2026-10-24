import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { realpathSync, rmSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { prepareLocalCandidate } from "./lib/local.mjs";
import {
  command,
  capture,
  shell,
  quote,
  sha256,
  deploymentOptions,
  assertProductionRevision,
  writeJSON,
  atomic,
} from "./lib/common.mjs";
import { loadConfig, loadDemoConfig, demoStateRoot, projectRoot } from "./lib/config.mjs";
import { parseCommandLine, showHelp } from "./lib/cli-options.mjs";
import { processIdentity } from "./lib/process-identity.mjs";

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
  if (invocation.target === "demo") {
    await localDemo(options);
    return;
  }
  if (invocation.target === "status") {
    const run = join(demoStateRoot(), invocation.argument);
    if (existsSync(run)) {
      await follow(
        (words) => capture(process.execPath, words),
        (words) => words,
        root,
        run,
      );
      return;
    }
  }
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
      const tools = join(run, "tools");
      remote(["mkdir", "-p", dirname(run)]);
      remote(["mkdir", "-m", "700", run]);
      remote(["mkdir", "-m", "700", tools]);
      const upload = (path, content) =>
        command("ssh", [config.host, `umask 077; cat > ${quote(path)}`], {
          input: content,
          stdio: ["pipe", "inherit", "inherit"],
        });
      upload(join(run, "tools.tar.gz"), implementation);
      remote(["tar", "-xzf", join(run, "tools.tar.gz"), "-C", tools]);
      upload(join(run, "source.tar.gz"), source);
      upload(join(run, "frontend.tar.gz"), local.frontend);
      upload(
        join(run, "request.json.next"),
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
      remote(["mv", "-T", join(run, "request.json.next"), join(run, "request.json")]);
      remote([
        "bash",
        "-c",
        "tmux new-session -d -s bg 2>/dev/null || tmux has-session -t bg",
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
    if (state.demo && state.demo.status !== "starting") {
      printDemo(state.demo, run);
      process.exitCode = state.exit ?? (state.demo.status === "failed" ? 1 : 0);
      return;
    }
    if (state.exit !== null) {
      if (state.demo) printDemo(state.demo, run);
      process.exitCode = state.exit;
      return;
    }
    if (state.orphaned)
      throw new Error(
        `Deployment worker is incomplete or no longer running. Inspect ${run}; recovery may be required. Do not assume deployment succeeded.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function printDemo(lease, run) {
  console.log(`Demo ${lease.status}: ${lease.origin ?? "origin not ready"}`);
  if (lease.seed?.kind === "imported")
    console.log("Staging data imported into private demo storage.");
  else if (lease.seed?.kind === "skipped")
    console.log(`Staging data skipped. Using fresh data. Reason ${lease.seed.reason}.`);
  if (lease.expiresAt) console.log(`24-hour runtime deadline: ${lease.expiresAt}`);
  if (lease.stoppedAt) console.log(`Stopped: ${lease.stoppedAt}`);
  console.log(`Data and encryption key retained until manually removed: ${lease.runtimeDir ?? run}`);
  console.log(`Service: ${lease.unit ?? "not recorded"}. Log: ${join(run, "demo.log")}`);
}

async function localDemo(options) {
  const config = loadDemoConfig(projectRoot, {
    ...process.env,
    ...(options.httpsPort === undefined ? {} : { OPS_DEMO_HTTPS_PORT: String(options.httpsPort) }),
  });
  const caller = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  if (caller.status === 0) {
    const checkout = caller.stdout.trim();
    const common = (directory) => capture("git", [
      "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    if (realpathSync(common(checkout)) === realpathSync(common(projectRoot)))
      config.repository = checkout;
  }
  const revision = capture("git", [
    "-C", config.repository, "rev-parse", "--verify", `${options.revision}^{commit}`,
  ]);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid application revision");
  const opsRevision = capture("git", ["-C", root, "rev-parse", "--verify", "HEAD"]);
  if (options.plan) {
    console.log(JSON.stringify({
      revision, opsRevision, target: "demo", validation: options.tests,
      stages: [
        "build committed candidate locally with fresh isolated validation data",
        options.tests === "skip" ? "skip test suites explicitly" : `run ${options.tests} test suites locally`,
        ...(options.reuseDemo === undefined ? [
          "try a private staging database, outputs and encryption-key snapshot when staging is configured",
          "check the snapshot with the candidate's existing storage initialization and recovery",
          "skip unavailable or incompatible staging data and initialize fresh demo storage without adding migrations",
        ] : [
          `require stopped, expired or failed local demo ${options.reuseDemo}; reject active or unsafe sources`,
          "copy its SQLite and WAL to private scratch, take candidate-installed readonly SQLite backup and independently copy outputs",
          "reuse its encryption key and same-origin session cookie name; create a fresh private environment, frontend and socket before normal app storage migration",
        ]),
        "start foreground Tailscale HTTPS in a per-run transient current-user service with an isolated session cookie name",
        "stop the full service control group after 24 hours",
        "retain all demo data and its encryption key until manually removed",
      ],
      config: { repository: config.repository, stateRoot: config.demo.stateRoot, httpsPort: config.demo.httpsPort },
      ...(options.reuseDemo === undefined ? {} : { reuseDemo: options.reuseDemo }),
      note: "Runtime stays under the current local user. An optional staging snapshot uses SSH; no shared deployment lock, PM2 or service changes. This plan creates no state, reads no source data and makes no SSH calls.",
    }, null, 2));
    return;
  }
  for (const directory of [config.repository, root])
    if (capture("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"]))
      throw new Error(`Commit changes before deploying: ${directory}`);
  const archived = spawnSync("git", [
    "-C", config.repository, "archive", "--format=tar.gz", revision,
  ], { maxBuffer: 256 * 1024 * 1024 });
  if (archived.status !== 0) throw new Error("Could not archive committed source");
  mkdirSync(config.demo.stateRoot, { recursive: true, mode: 0o700 });
  const run = mkdtempSync(join(config.demo.stateRoot, `${new Date().toISOString().replace(/[^0-9]/g, "")}-`));
  const request = {
    ...options, revision, opsRevision, id: basename(run),
    sourceHash: sha256(archived.stdout), config,
  };
  writeJSON(join(run, "request.json"), request);
  writeJSON(join(run, "owner.json"), processIdentity());
  const result = {
    run: request.id, revision, opsRevision, target: "demo",
    status: "running", startedAt: new Date().toISOString(), stages: [],
  };
  writeJSON(join(run, "result.json"), result);
  console.log(`Local demo run ${request.id}: ${run}`);
  let exit = 1;
  try {
    const local = await prepareLocalCandidate(request, archived.stdout, run);
    result.validation = local.validation;
    result.stages.push({ phase: "validated", at: new Date().toISOString() });
    writeJSON(join(run, "result.json"), result);
    const { startDemo } = await import("./lib/demo.mjs");
    const lease = await startDemo(request, run, local.build);
    result.status = "succeeded";
    if (lease.seed) result.seed = lease.seed;
    result.stages.push({ phase: "started", at: new Date().toISOString() });
    printDemo(lease, run);
    console.log(`Startup handed off. Reconnect with: ./deploy.sh status ${request.id}`);
    exit = 0;
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
    throw error;
  } finally {
    result.completedAt = new Date().toISOString();
    writeJSON(join(run, "result.json"), result);
    atomic(join(run, "exit"), `${exit}\n`);
  }
}
