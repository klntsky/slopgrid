import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { validateConfig } from "./common.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function configFromEnvironment(values, root = projectRoot) {
  const config = {
    host: values.OPS_HOST,
    repository: resolve(root, values.OPS_REPOSITORY || "."),
    masterRepository: values.OPS_MASTER_REPOSITORY,
    remoteRoot: values.OPS_REMOTE_ROOT,
    nodePath: values.OPS_NODE_PATH,
    targets: {},
  };
  if (values.OPS_TEST_ENV_FILE) config.testEnvFile = values.OPS_TEST_ENV_FILE;
  for (const name of ["staging", "production"]) {
    const prefix = `OPS_${name.toUpperCase()}_`;
    config.targets[name] = {
      state: values[prefix + "STATE"],
      config: values[prefix + "CONFIG"],
      applicationRoot: values[prefix + "APPLICATION_ROOT"],
      envFile: values[prefix + "ENV_FILE"],
      webProcess: values[prefix + "WEB_PROCESS"],
      engineProcess: values[prefix + "ENGINE_PROCESS"],
    };
  }
  return validateConfig(config);
}

export function loadConfig(root = projectRoot, inherited = process.env) {
  const path = join(root, ".env");
  const values = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  return configFromEnvironment({ ...values, ...inherited }, root);
}
