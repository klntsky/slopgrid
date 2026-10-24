import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

const deployments = ["validate", "demo", "rehearse", "staging", "production"];
const scopedTargets = ["validate", "demo", "rehearse", "staging"];
export const commands = {
  validate: {
    argument: "[REV]",
    description:
      "Validate a committed candidate locally in an isolated workspace without deploying.",
    details:
      "Runs the complete suite by default. Scoped tests select individual files. Skipped tests and deployment modes other than the explicit default --mode=auto are not permitted.",
  },
  demo: {
    argument: "[REV]",
    description:
      "Run a private 24-hour demo as the current local user after isolated validation.",
    details:
      "Uses foreground Tailscale HTTPS and a transient user service. Ordinary demos try a private staging snapshot and start fresh if it is unavailable or incompatible. Data and its encryption key are retained after stopping until manually removed. Full, scoped or explicitly skipped local tests are supported. Runtime processes stay local; optional staging snapshots use SSH without PM2 or shared runtime changes.",
  },
  rehearse: {
    argument: "[REV]",
    description:
      "Test locally and rehearse migrations remotely on a private full copy of production data.",
    details:
      "Changes neither runtime. Runs the complete suite by default; --skip-tests still runs migrations. Deployment modes are not permitted.",
  },
  staging: {
    argument: "[REV]",
    description:
      "Deploy the administrative staging runtime after isolated validation.",
    details:
      "Grid deletion runs after draining and backup and requires machinery mode. Failed-start recovery requires runtime safety checks and machinery mode; neither option permits soft mode.",
  },
  production: {
    argument: "[REV]",
    description:
      "Deploy only the authoritative master tip to the single production runtime.",
    details:
      "Requires the full suite or explicit --skip-tests; scoped tests are not permitted. Authoritative master checks and full-data migration rehearsal still apply when tests are skipped. Never changes staging.",
  },
  status: {
    argument: "RUN_ID",
    description: "Inspect a local demo or follow an existing remote run.",
    details:
      "Local demo status includes its deadline and retained data. Remote work continues in tmux bg after SSH disconnects.",
  },
};

const options = {
  help: {
    type: "boolean",
    short: "h",
    targets: Object.keys(commands),
    description:
      "Show help without loading configuration or contacting infrastructure.",
  },
  mode: {
    type: "string",
    value: "auto|soft|machinery",
    targets: ["staging", "production"],
    // Validation intentionally permits the explicit default, but no deployment mode.
    exceptions: { validate: (value) => value === "auto" },
    error: (target) =>
      target === "rehearse" || target === "demo"
        ? `${target === "demo" ? "Demo" : "Rehearsal"} does not accept deployment modes`
        : "Validation requires tests and does not accept deployment modes",
    description:
      "Deployment mode (default: auto); soft rejects incompatible engine changes.",
  },
  "skip-tests": {
    type: "boolean",
    targets: ["demo", "rehearse", "staging", "production"],
    error: () =>
      "Validation requires tests and does not accept deployment modes",
    description:
      "Explicitly skip test suites, not required migrations or production authorization.",
  },
  unit: {
    type: "string",
    multiple: true,
    value: "FILE",
    targets: scopedTargets,
    error: () => "Production requires the full suite or explicit --skip-tests",
    description: "Select a tests/*.test.ts file; repeat for more files.",
  },
  browser: {
    type: "string",
    multiple: true,
    value: "FILE",
    targets: scopedTargets,
    error: () => "Production requires the full suite or explicit --skip-tests",
    description: "Select a tests/*.spec.ts file; repeat for more files.",
  },
  suite: {
    type: "string",
    value: "mock|real",
    targets: deployments,
    description:
      "Scoped browser suite (default: mock); accepted but unused for full-suite runs.",
  },
  grep: {
    type: "string",
    value: "PATTERN",
    targets: scopedTargets,
    description: "Filter browser cases; requires --browser.",
  },
  "discard-grid": {
    type: "string",
    multiple: true,
    value: "ID",
    targets: ["staging"],
    error: () => "Grid deletion is only permitted on staging",
    description:
      "Delete a selected staging grid after backup; repeat for more IDs.",
  },
  "recover-failed-start": {
    type: "boolean",
    targets: ["staging"],
    error: () => "--recover-failed-start is only permitted on staging",
    description:
      "Recover an unpromoted staging engine that failed before readiness.",
  },
  "reuse-demo": {
    type: "string",
    value: "RUN_ID",
    targets: ["demo"],
    error: () => "--reuse-demo is only permitted on demo",
    description:
      "Snapshot a stopped local demo's database and outputs and retain its encryption key.",
  },
  "https-port": {
    type: "string",
    value: "PORT",
    targets: ["demo"],
    error: () => "--https-port is only permitted on demo",
    description:
      "Override the demo HTTPS listener port; use a distinct port for each concurrent demo.",
  },
  plan: {
    type: "boolean",
    targets: deployments,
    description:
      "Print a plan without uploading or changing runtime processes; production queries master.",
  },
};
const parserOptions = Object.fromEntries(
  Object.entries(options).map(([name, { type, short, multiple }]) => [
    name,
    {
      type,
      ...(short ? { short } : {}),
      ...(multiple ? { multiple } : {}),
    },
  ]),
);

export function assertOptionTargets(target, values) {
  for (const [name, value] of Object.entries(values)) {
    const option = options[name];
    if (option.targets.includes(target) || option.exceptions?.[target]?.(value))
      continue;
    throw new Error(
      target === "status"
        ? "Status does not accept operational options"
        : (option.error?.(target) ?? `--${name} is not permitted on ${target}`),
    );
  }
}

export function parseCommandLine(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: parserOptions,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE")
      throw new Error(`Missing or invalid option argument: ${error.message}`);
    throw error;
  }
  const { values, positionals } = parsed;
  for (const [name, value] of Object.entries(values)) {
    if (options[name].type !== "string") continue;
    for (const item of Array.isArray(value) ? value : [value])
      if (!item || item.startsWith("--"))
        throw new Error(`Missing argument for --${name}`);
  }
  const [target, argument] = positionals;
  const help = target === "help" || values.help || !args.length;
  if (target === "help") {
    if (
      positionals.length > 2 ||
      (argument && !Object.hasOwn(commands, argument))
    )
      throw new Error("Help topic must name a command");
    if (Object.keys(values).some((name) => name !== "help"))
      throw new Error("Help does not accept operational options");
    return { help: true, target: argument, values };
  }
  if (target && !Object.hasOwn(commands, target))
    throw new Error(
      "Target must be validate, demo, rehearse, staging, production or status",
    );
  if (positionals.length > 2 || argument?.startsWith("-"))
    throw new Error(
      `Unknown argument: ${positionals.slice(2).join(" ") || argument}`,
    );
  if (!target && !help) throw new Error("A command is required");
  if (!target && Object.keys(values).some((name) => name !== "help"))
    throw new Error("A command is required for operational options");
  if (target === "status") {
    assertOptionTargets(target, values);
    if (!help && !/^[a-zA-Z0-9-]+$/.test(argument ?? ""))
      throw new Error("Invalid run ID");
  }
  return { target, argument, values, help: Boolean(help) };
}

export function renderHelp(topic) {
  if (topic && !Object.hasOwn(commands, topic))
    throw new Error("Unknown help topic");
  const selected = topic
    ? [[topic, commands[topic]]]
    : Object.entries(commands);
  const lines = [
    "Usage:",
    ...selected.map(
      ([name, entry]) => `  ./deploy.sh ${name} ${entry.argument}`,
    ),
    "  ./deploy.sh help [COMMAND]",
    "  ./deploy.sh [COMMAND] --help",
    "",
    "Commands:",
  ];
  for (const [name, entry] of selected) {
    lines.push(`  ${name}: ${entry.description}`);
    if (topic) lines.push(`  ${entry.details}`);
  }
  lines.push("", "Options:");
  for (const [name, option] of Object.entries(options)) {
    if (topic && !option.targets.includes(topic)) continue;
    const label = `--${name}${option.value ? ` ${option.value}` : ""}${option.short ? `, -${option.short}` : ""}`;
    lines.push(
      `  ${label}`,
      `    ${option.description}${!topic && name !== "help" ? ` Commands: ${option.targets.join(", ")}.` : ""}`,
    );
  }
  lines.push(
    "",
    ...(!topic || commands[topic].argument === "[REV]"
      ? ["REV defaults to HEAD."]
      : []),
    "Options with values accept --flag=value. Unknown options and extra arguments are errors.",
    "Configuration: OPS_* in the application repository root .env; environment overrides allowed.",
    "Help never loads configuration or invokes Git, SSH or deployment commands.",
  );
  return lines.join("\n") + "\n";
}

export async function showHelp(
  topic,
  { input = process.stdin, output = process.stdout } = {},
) {
  output.write(renderHelp(topic));
  if (!input.isTTY || !output.isTTY) return;
  const reader = createInterface({ input, output, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  try {
    while (true) {
      output.write(
        `\nHelp topic (${Object.keys(commands).join(", ")}, all; q to exit): `,
      );
      const next = await lines.next();
      if (next.done) break;
      const choice = next.value.trim().toLowerCase();
      if (["q", "quit", "exit"].includes(choice) || !choice) break;
      if (choice === "all" || Object.hasOwn(commands, choice))
        output.write(renderHelp(choice === "all" ? undefined : choice));
      else
        output.write(
          "Choose a listed command, all, or q. Help never runs a command.\n",
        );
    }
  } finally {
    reader.close();
  }
}
