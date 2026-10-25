import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(project, "vendor/gstack");
const destination = join(project, ".omp/skills");
const staging = mkdtempSync(join(tmpdir(), "slopgrid-gstack-"));
const marker = "<!-- Installed by scripts/install-gstack.mjs; explicit invocation only. -->";

try {
  const generated = spawnSync(process.env.BUN ?? "bun", [
    "--no-env-file", "--config=/dev/null", "run",
    join(source, "scripts/gen-skill-docs.ts"),
    "--host", "opencode", "--out-dir", staging,
    "--link-root", source, "--install-root", source,
  ], { cwd: source, encoding: "utf8" });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout);

  const renderedRoot = join(staging, ".opencode/skills");
  const rendered = readdirSync(renderedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .filter((directory) => existsSync(join(renderedRoot, directory, "SKILL.md")));
  const installs = rendered.map((directory) => {
    const text = readFileSync(join(renderedRoot, directory, "SKILL.md"), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error(`Missing frontmatter: ${directory}`);
    const original = match[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
    if (!original) throw new Error(`Missing skill name: ${directory}`);
    const name = original === "gstack" || original.startsWith("gstack-") ? original : `gstack-${original}`;
    const target = join(destination, name);
    if (existsSync(target) && !readFileSync(join(target, "SKILL.md"), "utf8").includes(marker)) {
      throw new Error(`Refusing to overwrite an unmanaged skill: ${target}`);
    }
    const frontmatter = match[1].replace(/^name:.*$/m, `name: ${name}`);
    const assets = join(source, original === "gstack" ? "." : original);
    const instructions = `${marker}

## OMP invocation

This skill runs only when the user explicitly requests it.
Treat PROACTIVE as false, regardless of gstack configuration.
Do not suggest or invoke other skills unless the user's request includes them.
Repository instructions and OMP tool policies take precedence over this workflow.

Use OMP tools: Bash = bash, Read = read, Write = write, Edit = edit,
Grep = grep, Glob = glob, Agent = task, AskUserQuestion = ask,
WebSearch = web_search. Plan-mode transitions remain controlled by OMP.
Invoke installed skills with /skill:gstack-NAME (the router is /skill:gstack).
Resolve relative source assets against ${assets}.
Update this pinned installation through the repository submodule and this
installer, not upstream auto-update or setup.

`;
    const body = text.slice(match[0].length).replace(/^\*\*OpenCode tool names:\*\*.*\n/m, "");
    return { directory, name, target, content: `---\n${frontmatter}\ndisable-model-invocation: true\n---\n${instructions}${body}` };
  });

  mkdirSync(destination, { recursive: true });
  for (const install of installs) {
    mkdirSync(install.target, { recursive: true });
    const renderedDirectory = join(renderedRoot, install.directory);
    for (const entry of readdirSync(renderedDirectory)) {
      if (entry !== "SKILL.md") cpSync(join(renderedDirectory, entry), join(install.target, entry), { recursive: true });
    }
    writeFileSync(join(install.target, "SKILL.md"), install.content);
  }
  const current = new Set(installs.map((install) => install.name));
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    const skill = join(destination, entry.name, "SKILL.md");
    if (entry.isDirectory() && !current.has(entry.name) && existsSync(skill) && readFileSync(skill, "utf8").includes(marker)) {
      rmSync(join(destination, entry.name), { recursive: true });
    }
  }
  console.log(`Installed ${installs.length} explicit-only gstack skills in ${destination}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
