import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const versions = Object.freeze({
  fstar: "2026.10.25",
  opam: "2.3.0",
  ocaml: "4.14.2",
  jsOfOcaml: "6.0.1",
  zarith: "1.14",
  yojson: "2.2.2",
  batteries: "3.9.0",
  ppxDeriving: "6.0.3",
  ppxDerivingYojson: "3.9.0",
  zarithStubsJs: "v0.17.0",
  gmp: "6.3.0",
  m4: "1.4.19",
  opamRepository: "51f676b54a4f3990fef05c9c8098a07e878b8a0b",
});
export const toolchainRoot = resolve(
  process.env.CREATION_TOOLCHAIN_ROOT ??
    join(homedir(), ".local/share/slopgrid-creation-toolchain"),
);
export const toolchain = Object.freeze({
  root: toolchainRoot,
  opam: join(toolchainRoot, "bin/opam"),
  opamRoot: join(toolchainRoot, "opam"),
  switch: "creation",
  fstar: join(toolchainRoot, "fstar/fstar/bin/fstar.exe"),
  zarithRuntime: join(toolchainRoot, "zarith-runtime/runtime.js"),
});

function run(program, args, env = process.env, cwd) {
  const result = spawnSync(program, args, { stdio: "inherit", env, cwd });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} exited with ${result.status}`);
}

async function download(url, destination, digest) {
  try {
    const existing = await readFile(destination);
    if (createHash("sha256").update(existing).digest("hex") === digest) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== digest)
    throw new Error(`Checksum mismatch: ${url}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(`${destination}.download`, data);
  await rename(`${destination}.download`, destination);
}

export async function setup() {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The pinned creation toolchain requires Linux x86_64.");
  await mkdir(join(toolchainRoot, "bin"), { recursive: true });
  await download(
    `https://raw.githubusercontent.com/janestreet/zarith_stubs_js/${versions.zarithStubsJs}/runtime.js`,
    toolchain.zarithRuntime,
    "dfd1b97e69083705e0a8779f142d39411eae5178de40c68329ffd8404c08ced9",
  );
  await download(
    `https://github.com/ocaml/opam/releases/download/${versions.opam}/opam-${versions.opam}-x86_64-linux`,
    toolchain.opam,
    "324e78e3f33efeba279aacf9f9610cfec7b2df7d7e0e1640f75f09de85f96cc9",
  );
  await chmod(toolchain.opam, 0o755);
  const archive = join(toolchainRoot, `fstar-v${versions.fstar}.tar.gz`);
  await download(
    `https://github.com/FStarLang/FStar/releases/download/v${versions.fstar}/fstar-v${versions.fstar}-Linux-x86_64.tar.gz`,
    archive,
    "a716153960545bc26b9d093f55614fedc716a202e4daa1665e5c63e4a2fb04e4",
  );
  try {
    await stat(toolchain.fstar);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(join(toolchainRoot, "fstar"), { recursive: true });
    run("tar", [
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      join(toolchainRoot, "fstar"),
    ]);
  }
  const buildEnv = {
    ...process.env,
    PATH: `${join(toolchainRoot, "bin")}:${process.env.PATH ?? ""}`,
  };
  const m4Archive = join(toolchainRoot, `m4-${versions.m4}.tar.xz`);
  await download(
    `https://ftp.gnu.org/gnu/m4/m4-${versions.m4}.tar.xz`,
    m4Archive,
    "63aede5c6d33b6d9b13511cd0be2cac046f2e70fd0a07aa9573a04a82783af96",
  );
  try {
    await stat(join(toolchainRoot, "bin/m4"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    run("tar", ["-xf", m4Archive, "-C", toolchainRoot]);
    const source = join(toolchainRoot, `m4-${versions.m4}`);
    run(
      join(source, "configure"),
      [`--prefix=${toolchainRoot}`],
      buildEnv,
      source,
    );
    run("make", ["-j4"], buildEnv, source);
    run("make", ["install"], buildEnv, source);
  }
  const gmp = join(toolchainRoot, "gmp");
  const gmpArchive = join(toolchainRoot, `gmp-${versions.gmp}.tar.xz`);
  await download(
    `https://ftp.gnu.org/gnu/gmp/gmp-${versions.gmp}.tar.xz`,
    gmpArchive,
    "a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898",
  );
  try {
    await stat(join(gmp, ".creation-pic"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const source = join(toolchainRoot, `gmp-${versions.gmp}`);
    await rm(source, { recursive: true, force: true });
    run("tar", ["-xf", gmpArchive, "-C", toolchainRoot]);
    run(
      join(source, "configure"),
      [`--prefix=${gmp}`, "--disable-shared", "--with-pic"],
      buildEnv,
      source,
    );
    run("make", ["-j4"], buildEnv, source);
    run("make", ["install"], buildEnv, source);
    await writeFile(join(gmp, ".creation-pic"), `${versions.gmp}\n`);
  }
  const env = {
    ...buildEnv,
    OPAMROOT: toolchain.opamRoot,
    OPAMYES: "1",
    C_INCLUDE_PATH: [join(gmp, "include"), process.env.C_INCLUDE_PATH]
      .filter(Boolean)
      .join(":"),
    LIBRARY_PATH: [join(gmp, "lib"), process.env.LIBRARY_PATH]
      .filter(Boolean)
      .join(":"),
  };
  const repository = `git+https://github.com/ocaml/opam-repository.git#${versions.opamRepository}`;
  try {
    await stat(join(toolchain.opamRoot, "config"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    run(
      toolchain.opam,
      [
        "init",
        "--bare",
        "--disable-sandboxing",
        "--no-setup",
        "--yes",
        "default",
        repository,
      ],
      env,
    );
  }
  run(
    toolchain.opam,
    ["repository", "set-url", "default", repository, "--yes"],
    env,
  );
  const switches = spawnSync(toolchain.opam, ["switch", "list", "--short"], {
    env,
    encoding: "utf8",
  });
  if (switches.status !== 0) throw new Error("Cannot list opam switches.");
  if (!switches.stdout.split(/\r?\n/).includes(toolchain.switch)) {
    run(
      toolchain.opam,
      [
        "switch",
        "create",
        toolchain.switch,
        `ocaml-base-compiler.${versions.ocaml}`,
        "--yes",
        "--jobs=4",
      ],
      env,
    );
  }
  run(
    toolchain.opam,
    [
      "install",
      "--switch",
      toolchain.switch,
      "--yes",
      "--jobs=4",
      "--assume-depexts",
      `js_of_ocaml.${versions.jsOfOcaml}`,
      `js_of_ocaml-ppx.${versions.jsOfOcaml}`,
      `zarith.${versions.zarith}`,
      `yojson.${versions.yojson}`,
      "ocamlfind.1.9.8",
      `batteries.${versions.batteries}`,
      `ppx_deriving.${versions.ppxDeriving}`,
      `ppx_deriving_yojson.${versions.ppxDerivingYojson}`,
    ],
    env,
  );
  run(toolchain.fstar, ["--version"]);
  run(toolchain.opam, ["--version"], env);
  run(
    toolchain.opam,
    ["exec", "--switch", toolchain.switch, "--", "ocamlc", "-version"],
    env,
  );
  run(
    toolchain.opam,
    ["exec", "--switch", toolchain.switch, "--", "js_of_ocaml", "--version"],
    env,
  );
  console.log(`Creation toolchain installed at ${toolchainRoot}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setup().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
