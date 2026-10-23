import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { isDeepStrictEqual } from "node:util";
import {
  command,
  capture,
  readJSON,
  writeJSON,
  atomic,
  validateConfig,
  chooseMode,
  assertProductionRevision,
} from "./common.mjs";
import {
  prepareBuild,
  prepareRelease,
  engineFingerprint,
} from "./artifacts.mjs";
import { validateRemoteBuild } from "./validate.mjs";
import {
  environment,
  engineEnvironment,
  currentEngine,
  processes,
  control,
  assertFailedStartRecovery,
  backup,
  configureProcesses,
  discardStagingGrids,
  stopProcess,
  startProcess,
  retainFrontend,
  verifyStaging,
} from "./runtime.mjs";

function validateRecoveryRequest(request) {
  if (
    request.recoverFailedStart !== undefined &&
    typeof request.recoverFailedStart !== "boolean"
  )
    throw new Error("recoverFailedStart must be a boolean");
  if (
    request.target === "rehearse" &&
    request.mode !== undefined &&
    request.mode !== "auto"
  )
    throw new Error("Rehearsal does not accept deployment modes");
  if (!request.recoverFailedStart) return;
  if (request.target !== "staging")
    throw new Error("Failed-start recovery is only permitted on staging");
  if (request.mode === "soft")
    throw new Error("Failed-start recovery requires a machinery deployment");
}

// This ordering is shared by the real pipeline and orchestration regression tests.
export async function executePlan(request, operations) {
  validateRecoveryRequest(request);
  assertProductionRevision(request);
  const build = await operations.build();
  const validation = await operations.validate(build);
  if (!["passed", "skipped"].includes(validation.status))
    throw new Error("Validation did not succeed");
  if (validation.status === "skipped" && request.tests !== "skip")
    throw new Error("Unrequested validation skip");
  if (
    request.target === "production" &&
    !["full", "skip"].includes(validation.policy)
  )
    throw new Error("Production requires full validation or explicit skip");
  assertProductionRevision(request);
  // Reject incompatible forced modes before touching any selected runtime.
  const names = ["validate", "rehearse"].includes(request.target)
    ? []
    : [request.target];
  const plans = [];
  for (const name of names) plans.push(await operations.prepare(name, build));
  for (const plan of plans) {
    assertProductionRevision(request);
    await operations.deploy(plan, build, validation);
  }
}

export async function pipeline(request, run) {
  validateConfig(request.config);
  validateRecoveryRequest(request);
  if (
    !/^[a-f0-9]{40}$/.test(request.revision) ||
    !/^[a-f0-9]{40}$/.test(request.opsRevision)
  )
    throw new Error("Invalid revision");
  if (
    !["validate", "rehearse", "staging", "production"].includes(
      request.target,
    ) ||
    !["full", "scoped", "skip"].includes(request.tests)
  )
    throw new Error("Invalid deployment request");
  if (request.discardGrids.length && request.target !== "staging")
    throw new Error("Grid deletion is only permitted on staging");
  if (request.target === "validate" && request.tests === "skip")
    throw new Error("Validation requires tests");
  assertProductionRevision(request);
  const config = request.config;
  const nonDeploying = ["validate", "rehearse"].includes(request.target);
  const programs = nonDeploying
    ? ["pnpm", "tar"]
    : ["pnpm", "pm2", "rsync", "tar"];
  for (const program of programs) capture("which", [program]);
  const environments = {};
  if (!nonDeploying) {
    command("pm2", ["ping"], { stdio: "ignore" });
    environments[request.target] = environment(config.targets[request.target]);
  }
  if (request.discardGrids.length) {
    environments.production = environment(config.targets.production);
    for (const key of [
      "DATABASE_PATH",
      "OUTPUTS_PATH",
      "PORT",
      "APP_ORIGIN",
      "GENERATION_SOCKET",
    ])
      if (environments.staging[key] === environments.production[key])
        throw new Error(`Staging and production share ${key}`);
  }
  const state = {
    run: request.id,
    revision: request.revision,
    opsRevision: request.opsRevision,
    target: request.target,
    status: "running",
    stages: [],
  };
  const record = (stage) => {
    state.stages.push({ ...stage, at: new Date().toISOString() });
    writeJSON(join(run, "result.json"), state);
  };
  record({ phase: "started" });
  try {
    await executePlan(request, {
      build: () => prepareBuild(request, run, true),
      validate: (build) => validateRemoteBuild(request, build, run),
      prepare: async (name, build) => {
        const target = config.targets[name],
          env = environments[name];
        const release = prepareRelease(target, build, request, run);
        const current = currentEngine(target);
        const envFile = join(target.config, `${name}-engine.env`);
        const envCompatible =
          existsSync(envFile) &&
          isDeepStrictEqual(
            parseEnv(readFileSync(envFile, "utf8")),
            engineEnvironment(env),
          );
        const before =
          current.running &&
          !request.recoverFailedStart &&
          envCompatible &&
          current.interpreter === process.execPath
            ? await engineFingerprint(current.path)
            : undefined;
        const mode = chooseMode(
          request.recoverFailedStart ? "machinery" : request.mode,
          before,
          build.manifest.fingerprint,
          request.discardGrids.length > 0,
        );
        console.log(`${name}: ${mode} deployment of ${request.revision}`);
        record({ phase: "prepared", target: name, mode });
        return { name, target, env, release, current, mode };
      },
      deploy: async (plan, build, validation) => {
        const { name, target, env, release, current, mode } = plan;
        const runtime = processes();
        const web = runtime.find((item) => item.name === target.webProcess);
        const webEnv = join(target.config, `${name}-web.env`);
        const alreadyCurrent =
          mode === "soft" &&
          web?.pm2_env?.status === "online" &&
          web.pm2_env.pm_cwd === release &&
          existsSync(webEnv) &&
          isDeepStrictEqual(parseEnv(readFileSync(webEnv, "utf8")), env);
        if (!alreadyCurrent) {
          record({ phase: "deploying", target: name, mode });
          if (mode === "machinery") {
            if (request.recoverFailedStart) {
              await assertFailedStartRecovery(target, name);
              record({ phase: "recovering-failed-start", target: name });
            } else if (current.running) {
              console.log(
                `${name}: draining accepted grids and unsettled calls without a timeout`,
              );
              control(target, name, current.path, "drain");
            }
            stopProcess(target.webProcess);
            stopProcess(target.engineProcess, true);
            record({ phase: "stopped", target: name });
            const path = await backup(target, release, env, request.id);
            record({ phase: "backed-up", target: name, path });
            if (request.discardGrids.length) {
              const discarded = discardStagingGrids(
                name,
                release,
                env,
                environments.production,
                request.discardGrids,
              );
              record({
                phase: "discarded-grids",
                target: name,
                gridIds: request.discardGrids,
                ...discarded,
              });
            }
          }
          const engine = mode === "machinery" ? release : current.path;
          const before =
            name === "staging" && mode === "soft"
              ? JSON.parse(control(target, name, engine, "status")).instance
              : undefined;
          retainFrontend(target, release);
          const processConfig = configureProcesses(
            target,
            name,
            engine,
            release,
            env,
            request.id,
          );
          if (mode === "machinery") {
            await startProcess(
              target,
              processConfig.apps[0],
              "Generation engine ready",
            );
            atomic(join(target.config, "engine-release.path"), engine + "\n");
            record({ phase: "engine-started", target: name });
          }
          stopProcess(target.webProcess, true);
          await startProcess(
            target,
            processConfig.apps[1],
            `slopgrid: ${env.APP_ORIGIN}`,
          );
          atomic(join(target.config, "web-release.path"), release + "\n");
          if (
            before &&
            JSON.parse(control(target, name, engine, "status")).instance !==
              before
          )
            throw new Error("Soft deployment replaced the inference engine");
        } else
          console.log(
            `${name}: this release and runtime configuration are already active`,
          );
        if (name === "staging")
          await verifyStaging(
            env,
            readFileSync(join(build.path, "dist/index.html"), "utf8"),
          );
        const deployment = {
          revision: request.revision,
          opsRevision: request.opsRevision,
          sourceHash: request.sourceHash,
          run: request.id,
          mode,
          validation,
          completedAt: new Date().toISOString(),
        };
        writeJSON(join(target.config, "deployment.json"), deployment);
        atomic(
          join(target.config, "deployed-source.sha"),
          request.revision + "\n",
        );
        command("pm2", ["save"], { stdio: "ignore" });
        record({ phase: "completed", target: name, mode });
      },
    });
    state.status = "succeeded";
    console.log(
      `${request.target === "rehearse" ? "Rehearsed" : nonDeploying ? "Validated" : "Deployed"} ${request.revision}${nonDeploying ? " without changing any persistent runtime" : ` to ${request.target}`}. No production HTTP verification requests were made.`,
    );
  } catch (error) {
    state.status = "failed";
    state.error = error.message;
    console.error(
      `${request.target === "rehearse" ? "Rehearsal" : nonDeploying ? "Validation" : "Deployment"} failed: ${error.message}. Inspect ${run}/result.json and the recorded process logs. Retry the same command after correcting the cause; no automatic database rollback is attempted.`,
    );
    throw error;
  } finally {
    state.completedAt = new Date().toISOString();
    writeJSON(join(run, "result.json"), state);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const path = process.argv[2];
  try {
    await pipeline(readJSON(path), dirname(path));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
