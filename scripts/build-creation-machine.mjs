import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolchain, versions } from "./setup-creation-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectory = join(root, "src/create/fstar");
const javascriptName = "creation-machine.generated.js";
const declarationName = "creation-machine.generated.d.ts";
const manifestName = "creation-machine.generated.json";
const declarations =
  'import type { WireCreationMachine } from "../machine-contract.js";\nexport declare const wireCreationMachine: WireCreationMachine<unknown>;\n';
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat().sort();
}

async function sources() {
  const paths = [
    ...(await filesBelow(join(root, "formal"))).filter((path) =>
      /\.(fst|fsti|ml|mli)$/.test(path),
    ),
    join(root, "scripts/setup-creation-toolchain.mjs"),
    join(root, "scripts/build-creation-machine.mjs"),
    join(root, "src/create/machine-contract.ts"),
    join(root, "src/create/input-events.ts"),
    join(root, "src/create/machine-codec.ts"),
    join(root, "server/domain.ts"),
    join(root, "server/image-settings.ts"),
  ].sort();
  const entries = await Promise.all(
    paths.map(async (path) => [
      relative(root, path).split("\\").join("/"),
      digest(await readFile(path)),
    ]),
  );
  return {
    fingerprint: digest(JSON.stringify(entries)),
    files: Object.fromEntries(entries),
  };
}

async function outputProblem(fingerprint) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(generatedDirectory, manifestName), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return "Creation machine generated output is missing.";
    if (error instanceof SyntaxError)
      return "Creation machine generated manifest is malformed.";
    throw error;
  }
  if (manifest?.sourceFingerprint !== fingerprint)
    return "Creation machine generated output is stale.";
  for (const name of [javascriptName, declarationName]) {
    let bytes;
    try {
      bytes = await readFile(join(generatedDirectory, name));
    } catch (error) {
      if (error.code === "ENOENT")
        return `Creation machine generated output is missing: ${name}.`;
      throw error;
    }
    if (digest(bytes) !== manifest.outputs?.[name])
      return `Creation machine generated output was modified: ${name}.`;
  }
  return null;
}

async function check({ regenerate = false } = {}) {
  const current = await sources();
  const problem = await outputProblem(current.fingerprint);
  if (problem) {
    if (regenerate) return generate();
    throw new Error(`${problem} Run pnpm creation:generate.`);
  }
  console.log(
    `Creation machine generated output is current (${current.fingerprint.slice(0, 12)}).`,
  );
}

function run(program, args, { cwd = root, capture = false } = {}) {
  const result = spawnSync(program, args, {
    cwd,
    env: {
      ...process.env,
      OPAMROOT: toolchain.opamRoot,
      SOURCE_DATE_EPOCH: "0",
      TZ: "UTC",
    },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${basename(program)} exited with ${result.status}`);
  return result.stdout?.trim();
}

function ocaml(program, args, options) {
  return run(
    toolchain.opam,
    ["exec", "--switch", toolchain.switch, "--", program, ...args],
    options,
  );
}

function verificationOrder(paths, fstarArgs) {
  const owned = new Map(paths.map((path) => [basename(path), path]));
  const dependencies = new Map();
  for (const path of [...paths].reverse()) {
    if (dependencies.has(basename(path))) continue;
    const output = run(toolchain.fstar, [...fstarArgs, "--dep", "full", path], {
      capture: true,
    });
    for (const line of output.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const rule = line.match(/^(.+?\.fsti?\.checked)\s*:\s*(.*)$/);
      if (!rule) continue;
      const name = basename(rule[1].replace(/\\(.)/g, "$1")).replace(
        /\.checked$/,
        "",
      );
      if (!owned.has(name)) continue;
      const tokens = rule[2].match(/(?:\\.|[^\s\\])+/g) ?? [];
      dependencies.set(
        name,
        tokens
          .map((token) =>
            basename(token.replace(/\\(.)/g, "$1")).replace(/\.checked$/, ""),
          )
          .filter((dependency) => dependency !== name && owned.has(dependency)),
      );
    }
    if (!dependencies.has(basename(path)))
      throw new Error(`F* did not report dependencies for ${path}.`);
  }
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name))
      throw new Error(`Cyclic formal dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(owned.get(name));
  }
  for (const name of owned.keys()) visit(name);
  return ordered;
}

function wrapJavascript(compiled, fingerprint) {
  return `// Generated from verified F* through OCaml and js_of_ocaml. Do not edit.\n// Source fingerprint: ${fingerprint}\nconst compiled = (() => {\n  const module = { exports: {} };\n  const exports = module.exports;\n  (function(module, exports) {\n${compiled}\n  }).call(undefined, module, exports);\n  return module.exports.creationMachine;\n})();\nconst handles = new WeakMap();\nfunction wrap(state) {\n  const handle = Object.freeze({});\n  handles.set(handle, state);\n  return handle;\n}\nfunction unwrap(handle) {\n  if (typeof handle !== "object" || handle === null || !handles.has(handle))\n    throw new TypeError("Unknown creation machine handle.");\n  return handles.get(handle);\n}\nexport const wireCreationMachine = Object.freeze({\n  init(initial, context) { return wrap(compiled.init(initial, context)); },\n  update(handle, event) {\n    const result = compiled.update(unwrap(handle), event);\n    return { state: wrap(result.state), output: result.output };\n  },\n  view(handle) { return compiled.view(unwrap(handle)); },\n});\n`;
}

async function generate() {
  const initial = await sources();
  const formalSources = Object.keys(initial.files).filter((path) =>
    /\.fsti?$/.test(path),
  );
  for (const path of formalSources) {
    const source = await readFile(join(root, path), "utf8");
    if (
      /\b(admit|assume|unsafe_coerce|magic)\b|--lax|admit_smt_queries/.test(
        source,
      )
    ) {
      throw new Error(`Unverified escape hatch in ${path}.`);
    }
  }
  const fstarVersion = run(toolchain.fstar, ["--version"], { capture: true });
  if (!fstarVersion.startsWith(`F* ${versions.fstar}\n`))
    throw new Error("Unexpected F* version; run pnpm creation:setup.");
  if (ocaml("ocamlc", ["-version"], { capture: true }) !== versions.ocaml)
    throw new Error("Unexpected OCaml version; run pnpm creation:setup.");
  if (
    ocaml("js_of_ocaml", ["--version"], { capture: true }) !==
    versions.jsOfOcaml
  )
    throw new Error("Unexpected js_of_ocaml version; run pnpm creation:setup.");
  await mkdir(join(root, ".creation-build"), { recursive: true });
  const temporary = await mkdtemp(join(root, ".creation-build/regenerate-"));
  try {
    const cache = join(temporary, "checked");
    const extracted = join(temporary, "ocaml");
    await mkdir(cache);
    await mkdir(extracted);
    const fstarArgs = [
      "--include",
      join(root, "formal"),
      "--cache_checked_modules",
      "--cache_dir",
      cache,
      "--already_cached",
      "* -Slopgrid",
    ];
    for (const path of verificationOrder(formalSources, fstarArgs)) {
      run(toolchain.fstar, [...fstarArgs, path]);
    }
    run(toolchain.fstar, [
      ...fstarArgs,
      "--codegen",
      "OCaml",
      "--custard_split",
      "--custard_entry_module",
      "Slopgrid.Data",
      "--custard_entry_module",
      "Slopgrid.Machine",
      "--odir",
      extracted,
      "formal/Slopgrid.Machine.fst",
    ]);
    const runtime = join(
      dirname(dirname(toolchain.fstar)),
      "lib/fstar/lib/app",
    );
    for (const name of [
      "Prims.ml",
      "FStar_Pervasives_Native.ml",
      "FStar_Pervasives.ml",
      "FStar_List_Tot_Base.ml",
      "FStar_List.ml",
    ]) {
      await copyFile(join(runtime, name), join(extracted, name));
    }
    for (const path of await filesBelow(join(root, "formal/ocaml"))) {
      if (/\.mli?$/.test(path))
        await copyFile(path, join(extracted, basename(path)));
    }
    const modules = (await readdir(extracted))
      .filter((name) => name.endsWith(".ml"))
      .sort();
    const sorted = ocaml("ocamlfind", ["ocamldep", "-sort", ...modules], {
      cwd: extracted,
      capture: true,
    }).split(/\s+/);
    const packages =
      "zarith,batteries.unthreaded,yojson,ppx_deriving.show,ppx_deriving_yojson,js_of_ocaml";
    ocaml(
      "ocamlfind",
      [
        "ocamlc",
        "-package",
        packages,
        "-linkpkg",
        "-o",
        "creation-machine.byte",
        ...sorted,
      ],
      { cwd: extracted },
    );
    ocaml(
      "js_of_ocaml",
      [
        "compile",
        "--target-env",
        "browser",
        "--Werror",
        "--disable",
        "genprim",
        "--pretty",
        "-o",
        "creation-machine.js",
        toolchain.zarithRuntime,
        "creation-machine.byte",
      ],
      { cwd: extracted },
    );
    const current = await sources();
    if (initial.fingerprint !== current.fingerprint)
      throw new Error(
        "Creation sources changed during generation; run pnpm creation:generate again.",
      );
    const javascript = wrapJavascript(
      await readFile(join(extracted, "creation-machine.js"), "utf8"),
      initial.fingerprint,
    );
    const manifest = `${JSON.stringify(
      {
        sourceFingerprint: initial.fingerprint,
        sources: initial.files,
        toolchain: versions,
        outputs: {
          [javascriptName]: digest(javascript),
          [declarationName]: digest(declarations),
        },
      },
      null,
      2,
    )}\n`;
    await mkdir(generatedDirectory, { recursive: true });
    for (const [name, content] of [
      [javascriptName, javascript],
      [declarationName, declarations],
      [manifestName, manifest],
    ]) {
      const staging = join(temporary, name);
      await writeFile(staging, content);
      await rename(staging, join(generatedDirectory, name));
    }
    console.log(
      `Regenerated creation machine (${initial.fingerprint.slice(0, 12)}).`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args.length === 1 && !["--check", "--ensure"].includes(args[0]))
) {
  console.error(
    "Usage: node scripts/build-creation-machine.mjs [--check|--ensure]",
  );
  process.exitCode = 1;
} else {
  const action =
    args[0] === "--ensure"
      ? check({ regenerate: true })
      : args[0] === "--check"
        ? check()
        : generate();
  action.catch((error) => {
    if (error.code === "ENOENT")
      console.error(
        "Creation machine prerequisites or generated files are missing. Run pnpm creation:setup, then pnpm creation:generate.",
      );
    else console.error(error.message);
    process.exitCode = 1;
  });
}
