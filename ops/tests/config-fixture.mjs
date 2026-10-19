import { join } from "node:path";

export function fixtureConfig(root) {
  const config = {
    host: "fixture.invalid",
    repository: join(root, "app"),
    masterRepository: join(root, "authority.git"),
    remoteRoot: join(root, "remote"),
    nodePath: process.env.PATH,
    targets: {},
  };
  for (const name of ["staging", "production"])
    config.targets[name] = {
      state: join(root, name, "state"),
      config: join(root, name, "config"),
      applicationRoot: join(root, name, "app"),
      envFile: join(root, name, "runtime.env"),
      webProcess: `fixture-${name}-web`,
      engineProcess: `fixture-${name}-engine`,
    };
  return config;
}

export function fixtureEnvironment(config) {
  const values = {
    OPS_HOST: config.host,
    OPS_REPOSITORY: config.repository,
    OPS_MASTER_REPOSITORY: config.masterRepository,
    OPS_REMOTE_ROOT: config.remoteRoot,
    OPS_NODE_PATH: config.nodePath,
    OPS_TEST_ENV_FILE: config.testEnvFile ?? "",
  };
  for (const [name, target] of Object.entries(config.targets))
    for (const [field, suffix] of Object.entries({
      state: "STATE", config: "CONFIG", applicationRoot: "APPLICATION_ROOT",
      envFile: "ENV_FILE", webProcess: "WEB_PROCESS", engineProcess: "ENGINE_PROCESS",
    })) values[`OPS_${name.toUpperCase()}_${suffix}`] = target[field];
  return values;
}
