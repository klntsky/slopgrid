import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  command,
  capture,
  shell,
  quote,
} from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";

// Pipeline tests always execute on the configured staging host in tmux bg.
const root = dirname(fileURLToPath(import.meta.url));
const selectors = process.argv.slice(2);
try {
  const config = loadConfig();
  const id = `check-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const run = join(config.remoteRoot, "checks", id);
  const remote = (words) => capture("ssh", [config.host, shell(words)]);
  const files = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (files.status !== 0)
    throw new Error("Could not enumerate pipeline source");
  const archive = spawnSync("tar", ["-czf", "-", "--null", "-T", "-"], {
    cwd: root,
    input: files.stdout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (archive.status !== 0)
    throw new Error("Could not archive pipeline source");
  remote(["mkdir", "-p", run]);
  command("ssh", [config.host, shell(["tar", "-xzf", "-", "-C", run])], {
    input: archive.stdout,
    stdio: ["pipe", "inherit", "inherit"],
  });
  remote([
    "bash",
    "-c",
    "tmux has-session -t bg 2>/dev/null || tmux new-session -d -s bg",
  ]);
  const app = remote([
    "cat",
    join(config.targets.staging.config, "web-release.path"),
  ]);
  remote([
    "tmux",
    "new-window",
    "-d",
    "-t",
    "bg",
    "-n",
    id,
    shell([
      "env",
      `PATH=${config.nodePath}`,
      `SLOPGRID_TEST_APP=${app}`,
      "bash",
      join(run, "test-run.sh"),
      run,
      ...selectors,
    ]),
  ]);
  console.log(`Pipeline tests: ${run}/run.log`);
  let offset = 0;
  for (;;) {
    const status = JSON.parse(
      remote([
        "env",
        `PATH=${config.nodePath}`,
        "node",
        join(run, "lib/status.mjs"),
        run,
        String(offset),
      ]),
    );
    process.stdout.write(status.log);
    offset = status.offset;
    if (status.exit !== null) {
      process.exitCode = status.exit;
      break;
    }
    if (status.orphaned) throw new Error("Pipeline test worker disappeared");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
