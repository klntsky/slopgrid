import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const archivedFixtureModels = [
  { id: "generator", name: "Historical image generator", image: true, imageInput: true, text: false, reasoning: false, reasoningMandatory: false },
  { id: "judge", name: "Historical judge", image: false, imageInput: true, text: true, reasoning: true, reasoningMandatory: false },
  { id: "fixture/text", name: "Fixture text", image: false, imageInput: true, text: true, reasoning: false, reasoningMandatory: false },
  { id: "fixture/image", name: "Fixture image", image: true, imageInput: true, text: false, reasoning: false, reasoningMandatory: false },
];

export function startFixtureCatalog(t, directory) {
  const address = join(directory, "model-catalog-address");
  const catalog = archivedFixtureModels.map((model) => ({
    id: model.id, name: model.name,
    architecture: {
      input_modalities: ["text", ...(model.imageInput ? ["image"] : [])],
      output_modalities: model.image ? ["image"] : ["text"],
    },
    supported_parameters: model.reasoning ? ["reasoning"] : [],
  }));
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const models = ${JSON.stringify(catalog)};
    const server = createServer((request, response) => {
      if (!['/models', '/images/models'].includes(request.url)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: request.url === '/images/models'
        ? models.filter((model) => model.architecture.output_modalities.includes('image')) : models }));
    });
    server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(address)}, 'http://127.0.0.1:' + server.address().port, { mode: 0o600 }));
  `], { stdio: "ignore" });
  let failure;
  child.on("error", (error) => { failure = error; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const deadline = Date.now() + 10000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(address)) {
    if (failure) throw failure;
    if (Date.now() >= deadline) throw new Error("Fixture model catalog did not start");
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return readFileSync(address, "utf8");
}
