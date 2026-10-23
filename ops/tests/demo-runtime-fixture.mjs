import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import { createServer as createHTTPS } from "node:https";
import { request as requestHTTP } from "node:http";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForDemo(predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function managerRequest(socketPath, command, args = []) {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let text = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.end(JSON.stringify({ command, args })));
    socket.on("data", (chunk) => { text += chunk; });
    socket.once("end", () => {
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function demoFixture(t, flags = {}) {
  const root = mkdtempSync(join(tmpdir(), "sg-demo-test-"));
  const run = join(root, "run");
  const buildPath = join(root, "candidate");
  const bin = join(root, "bin");
  for (const directory of [run, bin, join(buildPath, "server"), join(buildPath, "dist"), join(buildPath, "node_modules/tsx")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(buildPath, "package.json"), '{"type":"module"}');
  writeFileSync(join(buildPath, "dist/index.html"), "<html>fixture frontend</html>");
  writeFileSync(join(buildPath, "node_modules/tsx/package.json"), '{"type":"module","exports":"./index.mjs"}');
  writeFileSync(join(buildPath, "node_modules/tsx/index.mjs"), 'import { register } from "node:module"; register("./loader.mjs", import.meta.url);');
  writeFileSync(join(buildPath, "node_modules/tsx/loader.mjs"), `
    import { readFile } from "node:fs/promises";
    export async function load(url, context, next) {
      if (url.endsWith(".ts")) return { format: "module", source: await readFile(new URL(url), "utf8"), shortCircuit: true };
      return next(url, context);
    }
  `);
  writeFileSync(join(buildPath, "server/engine.ts"), `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { createServer } from "node:net";
    const flags = ${JSON.stringify(flags)};
    if (flags.engineExit) process.exit(7);
    mkdirSync(dirname(process.env.DATABASE_PATH), { recursive: true });
    mkdirSync(process.env.OUTPUTS_PATH, { recursive: true });
    writeFileSync(process.env.DATABASE_PATH, "retained database bytes");
    writeFileSync(join(process.env.OUTPUTS_PATH, "saved.html"), "retained output bytes");
    writeFileSync(join(dirname(process.env.DATABASE_PATH), "observed-engine.json"), JSON.stringify(process.env));
    createServer((socket) => socket.end("ready")).listen(process.env.GENERATION_SOCKET, () => {
      process.stdout.write("Generation engine ");
      setTimeout(() => process.stdout.write("ready\\n"), 10);
    });
    setInterval(() => {}, 1000);
  `);
  writeFileSync(join(buildPath, "server/index.ts"), `
    import { createServer } from "node:http";
    import { writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    const flags = ${JSON.stringify(flags)};
    if (flags.webExit) process.exit(8);
    writeFileSync(join(dirname(process.env.DATABASE_PATH), "observed-web.json"), JSON.stringify(process.env));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>demo fixture</html>");
    });
    server.listen(Number(process.env.PORT), process.env.BIND_ADDRESS, () => {
      process.send?.({ type: "ready", port: flags.wrongPort ? Number(process.env.PORT) + 1 : server.address().port });
      if (flags.exitAfterReady) setTimeout(() => process.exit(9), 1500);
    });
  `);
  const port = await freePort();
  const httpsPort = await freePort();
  const envFile = join(root, "dedicated.env");
  const writeEnvironment = (extra = "") => writeFileSync(envFile,
    `GITHUB_CLIENT_ID=demo-client\nGITHUB_CLIENT_SECRET=demo-secret\nOUTPUT_DOMAIN=-demo.example.invalid\nPORT=${port}\n${extra}`,
    { mode: 0o600 });
  writeEnvironment();
  const cert = join(root, "localhost.crt");
  const key = join(root, "localhost.key");
  const certificate = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  if (certificate.status !== 0) throw new Error("Demo fixtures require openssl certificate generation");
  const socketPath = join(root, "manager.sock");
  const configPath = join(root, "fixture.json");
  writeFileSync(configPath, JSON.stringify({ root, run, bin, cert, key, socketPath, flags, httpsPort }));
  for (const command of ["systemd-run", "systemctl", "loginctl", "tailscale"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!${process.execPath}\nimport { externalDemoCommand } from ${JSON.stringify(new URL(import.meta.url).href)};\nawait externalDemoCommand(${JSON.stringify(command)}, process.argv.slice(2));\n`);
    chmodSync(path, 0o700);
  }
  const manager = fork(fixturePath, ["--manager", configPath], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await once(manager, "message");
  const previous = { PATH: process.env.PATH, SLOPGRID_DEMO_FIXTURE: process.env.SLOPGRID_DEMO_FIXTURE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SLOPGRID_DEMO_FIXTURE = configPath;
  const control = (command, args) => managerRequest(socketPath, command, args);
  t.after(async () => {
    const exited = once(manager, "exit");
    await control("shutdown");
    await exited;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const leaseFile = join(run, "demo.json");
    if (existsSync(leaseFile)) {
      const lease = readJSON(leaseFile);
      if (lease.socketDir?.startsWith(join(tmpdir(), "sg-demo-"))) rmSync(lease.socketDir, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, run, build: { path: buildPath }, port, httpsPort, envFile, writeEnvironment, control,
    request: { target: "demo", id: "demo-fixture", revision: "a".repeat(40), config: { demo: { envFile, httpsPort, stateRoot: root } } },
    lease: () => readJSON(join(run, "demo.json")),
    audit: async () => (await control("audit")).audit,
  };
}

function descendants(pid) {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return children ? children.split(/\s+/).map(Number).flatMap((child) => [...descendants(child), child]) : [];
  } catch { return []; }
}

function splitExec(value) {
  return [...value.matchAll(/"(?:\\.|[^"\\])*"|[^\s]+/g)]
    .map(([part]) => (part.startsWith('"') ? JSON.parse(part) : part).replaceAll("%%", "%").replaceAll("$$", "$"));
}

async function runManager(configPath) {
  const config = readJSON(configPath);
  const audit = [];
  let service;
  let occupied = config.flags.occupiedUnit === true;
  let stopping;
  async function finish(result) {
    if (!service || stopping) return stopping;
    const current = service;
    stopping = (async () => {
      const exited = current.child.exitCode !== null || current.child.signalCode !== null
        ? Promise.resolve() : once(current.child, "exit");
      for (const pid of [...descendants(current.child.pid), current.child.pid]) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await exited;
      const [program, ...args] = splitExec(current.finalize);
      const finalized = spawnSync(program, args, {
        env: { ...current.env, SERVICE_RESULT: result, EXIT_CODE: result === "success" ? "exited" : "killed", EXIT_STATUS: result === "success" ? "0" : "9" },
        stdio: "inherit",
      });
      if (finalized.status !== 0) throw new Error(`Demo finalizer exited ${finalized.status}`);
      service = undefined;
      occupied = false;
    })();
    await stopping;
    stopping = undefined;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", async () => {
      try {
        const { command, args = [] } = JSON.parse(input);
        audit.push({ command, args });
        let response = { status: 0, stdout: "" };
        if (command === "systemd-run") {
          if (occupied || service) response = { status: 1, stderr: "Unit already exists" };
          else {
            const properties = args.filter((arg) => arg.startsWith("--property=")).map((arg) => arg.slice(11));
            const property = (name) => properties.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
            const executable = args.indexOf(process.execPath);
            if (executable < 0) throw new Error("Missing foreground runtime command");
            const env = { ...process.env, PATH: `${config.bin}:${process.env.PATH}`, SLOPGRID_DEMO_FIXTURE: configPath, NODE_EXTRA_CA_CERTS: config.cert, INVOCATION_ID: "fixture-invocation" };
            const logPath = property("StandardOutput").replace(/^append:/, "");
            const log = openSync(logPath, "a");
            const child = spawn(args[executable], args.slice(executable + 1), { env, stdio: ["ignore", log, log] });
            closeSync(log);
            service = { child, env, finalize: property("ExecStopPost") };
            occupied = true;
            child.once("exit", () => { if (!stopping) void finish("exit-code"); });
          }
        } else if (command === "systemctl") {
          if (args.includes("stop")) await finish("success");
          else if (args.includes("show")) response.stdout = args.some((arg) => arg.includes("InvocationID"))
            ? (service ? "fixture-invocation\n" : occupied ? "foreign-invocation\n" : "\n")
            : args.some((arg) => arg.includes("ActiveState")) ? (occupied ? "active\n" : "inactive\n") : (occupied ? "loaded\n" : "not-found\n");
          else if (args.includes("is-active")) response = { status: service ? 0 : 3, stdout: service ? "active\n" : "inactive\n" };
        } else if (command === "loginctl") response.stdout = config.flags.noLinger ? "no\n" : "yes\n";
        else if (command === "tailscale-status") response.stdout = JSON.stringify({ Self: { DNSName: "localhost." } });
        else if (command === "tailscale-serve-status") response.stdout = JSON.stringify({
          TCP: config.flags.occupiedServe ? { [args[0]]: { HTTPS: true } } : {},
          Foreground: config.flags.occupiedForeground ? { existing: { TCP: { [args[0]]: { HTTPS: true } } } } : {},
        });
        else if (command === "expire") await finish("timeout");
        else if (command === "foreign-service") occupied = true;
        else if (command === "audit") response.audit = audit;
        else if (command === "shutdown") {
          await finish("success");
          socket.end(JSON.stringify(response));
          server.close(() => process.exit(0));
          return;
        }
        socket.end(JSON.stringify(response));
      } catch (error) { socket.end(JSON.stringify({ status: 1, stderr: error.stack })); }
    });
  });
  server.listen(config.socketPath, () => process.send?.("ready"));
}

export async function externalDemoCommand(command, args) {
  const config = readJSON(process.env.SLOPGRID_DEMO_FIXTURE);
  if (command === "systemd-run" && config.flags.inspectStartup) {
    const { readDemoStatus } = await import("../lib/demo.mjs");
    readDemoStatus(config.run);
  }
  if (command === "tailscale" && args[0] === "serve" && !args.includes("status")) {
    await managerRequest(config.socketPath, "tailscale-foreground", args);
    if (config.flags.serveExit) process.exit(10);
    const httpsPort = Number(args.find((arg) => arg.startsWith("--https="))?.slice(8));
    const upstream = new URL(args.at(-1));
    const server = createHTTPS({ cert: readFileSync(config.cert), key: readFileSync(config.key) }, (request, response) => {
      if (config.flags.badHTTPS) { response.writeHead(503); response.end("not ready"); return; }
      const proxy = requestHTTP({ hostname: upstream.hostname, port: upstream.port, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      proxy.on("error", () => { response.writeHead(502); response.end(); });
      request.pipe(proxy);
    });
    server.listen(httpsPort, "127.0.0.1");
    server.on("error", () => process.exit(11));
    return;
  }
  let action = command;
  if (command === "tailscale") action = args[0] === "status" ? "tailscale-status" : "tailscale-serve-status";
  const response = await managerRequest(config.socketPath, action, action === "tailscale-serve-status" ? [config.httpsPort] : args);
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.status;
}

if (process.argv[2] === "--manager") await runManager(process.argv[3]);
