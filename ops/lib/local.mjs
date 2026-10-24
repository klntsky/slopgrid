import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild } from "./artifacts.mjs";
import { validateBuild } from "./validate.mjs";
import { capture, sha256 } from "./common.mjs";

// The caller owns cleanup so validated artifacts remain available for upload.
export async function prepareLocalCandidate(request, source, existingRun) {
  const run = existingRun ?? mkdtempSync(join(tmpdir(), "sg-candidate-"));
  try {
    writeFileSync(join(run, "source.tar.gz"), source);
    const build = await prepareBuild(request, run);
    const validation = await validateBuild(
      {
        ...request,
        target: "validate",
        config: { testEnvFile: process.env.SLOPGRID_LOCAL_TEST_ENV_FILE },
      },
      build,
      run,
    );
    capture("tar", [
      "-czf",
      join(run, "frontend.tar.gz"),
      "-C",
      build.path,
      "dist",
      "build.json",
    ]);
    const frontend = readFileSync(join(run, "frontend.tar.gz"));
    return { run, build, frontend, frontendHash: sha256(frontend), validation };
  } catch (error) {
    if (!existingRun) rmSync(run, { recursive: true, force: true });
    throw error;
  }
}
