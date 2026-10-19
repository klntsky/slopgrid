import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import {
  command,
  capture,
  readJSON,
  writeJSON,
  sha256,
  fileManifest,
  verifyManifest,
} from "./common.mjs";

export async function engineFingerprint(root) {
  const require = createRequire(join(root, "package.json"));
  const { build } = createRequire(require.resolve("tsx"))("esbuild");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["server/engine.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const files = [
    ...new Set([
      ...Object.keys(result.metafile.inputs),
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]),
  ].sort();
  return sha256(JSON.stringify(fileManifest(root, files)));
}

export async function prepareBuild(request, run) {
  const { revision } = request;
  const archive = join(run, "source.tar.gz");
  if (sha256(readFileSync(archive)) !== request.sourceHash)
    throw new Error("Source archive checksum mismatch");
  const candidate = join(run, "build");
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  command("tar", ["-xzf", archive, "-C", candidate]);
  const source = fileManifest(candidate, readdirSync(candidate).sort());
  const manifest = readJSON(join(candidate, "package.json"));
  const expectedPnpm = manifest.packageManager?.match(/^pnpm@([^+]+)/)?.[1];
  if (!expectedPnpm || capture("pnpm", ["--version"]) !== expectedPnpm)
    throw new Error(
      `Configure pnpm ${expectedPnpm ?? "from packageManager"} on the host before deploying`,
    );
  command("pnpm", ["install", "--frozen-lockfile"], { cwd: candidate });
  command("pnpm", ["build"], { cwd: candidate });
  verifyManifest(candidate, source);
  const result = {
    revision,
    sourceHash: request.sourceHash,
    opsRevision: request.opsRevision,
    node: process.version,
    pnpm: expectedPnpm,
    source,
    frontend: fileManifest(candidate, ["dist"]),
    fingerprint: await engineFingerprint(candidate),
    builtAt: new Date().toISOString(),
  };
  writeJSON(join(candidate, "build.json"), result);
  return { path: candidate, manifest: result };
}

export function validationWorkspace(build, run) {
  const workspace = join(run, "validation");
  mkdirSync(workspace, { mode: 0o700 });
  command("tar", ["-xzf", join(run, "source.tar.gz"), "-C", workspace]);
  cpSync(join(build.path, "dist"), join(workspace, "dist"), {
    recursive: true,
  });
  symlinkSync(
    join(build.path, "node_modules"),
    join(workspace, "node_modules"),
  );
  return workspace;
}

export function prepareRelease(target, build, request, run) {
  const release = join(target.state, "releases", request.revision);
  if (existsSync(release)) {
    // This also adopts releases created by earlier implementations, after verifying them.
    verifyManifest(release, build.manifest.source);
    verifyManifest(release, build.manifest.frontend);
    if (!existsSync(join(release, "node_modules")))
      throw new Error(`Release lacks dependencies: ${release}`);
    return release;
  }
  const pending = release + "-" + request.id;
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  command("tar", ["-xzf", join(run, "source.tar.gz"), "-C", pending]);
  command("pnpm", ["install", "--frozen-lockfile"], { cwd: pending });
  cpSync(join(build.path, "dist"), join(pending, "dist"), { recursive: true });
  verifyManifest(pending, build.manifest.source);
  writeJSON(join(pending, "release.json"), {
    revision: request.revision,
    sourceHash: request.sourceHash,
    opsRevision: request.opsRevision,
  });
  renameSync(pending, release);
  return release;
}
