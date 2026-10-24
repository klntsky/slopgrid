import { spawnSync } from "node:child_process";
import { shell } from "./common.mjs";

function readSource() {
  try {
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    const source = JSON.parse(process.argv[2]);
    const env = parseEnv(readFileSync(source.envFile, "utf8"));
    process.stdout.write(JSON.stringify({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }));
  } catch {
    process.exitCode = 1;
  }
}

export function readStagingGithubCredentials(source) {
  try {
    const command = shell([
      "env", `PATH=${source.nodePath}`, "node", "--input-type=commonjs", "-",
      JSON.stringify({ envFile: source.envFile }),
    ]);
    const result = spawnSync("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", source.host, command,
    ], {
      input: `(${readSource.toString()})()`, encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], timeout: 20000,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0 || Buffer.byteLength(result.stdout) > 64 * 1024) throw new Error();
    const pair = JSON.parse(result.stdout);
    if (
      !pair || typeof pair !== "object" || Array.isArray(pair) ||
      typeof pair.clientId !== "string" || !pair.clientId.trim() ||
      typeof pair.clientSecret !== "string" || !pair.clientSecret.trim()
    ) throw new Error();
    return { clientId: pair.clientId.trim(), clientSecret: pair.clientSecret.trim() };
  } catch {
    throw new Error("Could not read required GitHub client ID and secret from staging");
  }
}
