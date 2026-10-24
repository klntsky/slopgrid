import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
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

function demoValues(root, inherited) {
  const path = join(root, ".env");
  const values = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  return { ...values, ...inherited };
}

function stateRoot(values) {
  const path = values.OPS_DEMO_STATE_ROOT || join(
    values.XDG_STATE_HOME || join(values.HOME || homedir(), ".local", "state"),
    "slopgrid", "demos",
  );
  if (!isAbsolute(path) || /[\n\r\0]/.test(path))
    throw new Error("OPS_DEMO_STATE_ROOT must be an absolute local demo state path");
  return path;
}

export function demoStateRoot(root = projectRoot, inherited = process.env) {
  return stateRoot(demoValues(root, inherited));
}

export function loadDemoConfig(root = projectRoot, inherited = process.env) {
  const values = demoValues(root, inherited),
    envFile = values.OPS_DEMO_ENV_FILE,
    port = values.OPS_DEMO_HTTPS_PORT;
  if (typeof envFile !== "string" || !isAbsolute(envFile) || /[\n\r\0]/.test(envFile))
    throw new Error("Demo requires OPS_DEMO_ENV_FILE as an absolute local private env path");
  if (typeof port !== "string" || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Demo requires OPS_DEMO_HTTPS_PORT as an integer from 1 to 65535");
  const stagingSource = {
    host: values.OPS_HOST,
    nodePath: values.OPS_NODE_PATH,
    envFile: values.OPS_STAGING_ENV_FILE,
    applicationRoot: values.OPS_STAGING_APPLICATION_ROOT,
    config: values.OPS_STAGING_CONFIG,
  };
  const configured =
    Object.values(stagingSource).every(
      (value) => typeof value === "string" && value.length > 0 && !/[\n\r\0]/.test(value),
    ) &&
    !/^[\s-]|\s/.test(stagingSource.host) &&
    ["envFile", "applicationRoot", "config"].every((key) => isAbsolute(stagingSource[key]));
  return {
    repository: root,
    demo: {
      envFile, httpsPort: Number(port), stateRoot: stateRoot(values),
      ...(configured ? { stagingSource } : {}),
    },
  };
}
