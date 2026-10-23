import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const selectors = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ["--test", ...(selectors.length ? selectors : ["tests/*.test.mjs"])],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SLOPGRID_TEST_APP: resolve(root, "..") },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
