import { signalReady } from "./process-ready.js";
import { startGenerationFixture } from "./generation-fixture.js";
import { webFixture } from "./web-fixture.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseE2EPort } from "./e2e-port.js";
const port = parseE2EPort(process.env.E2E_PORT);
const data = process.env.FIXTURE_DATA!;
const secret = randomBytes(32);
const generation = await startGenerationFixture({
  database: join(data, "app.sqlite"),
  secret,
});
const web = await webFixture({
  port,
  database: join(data, "app.sqlite"),
  secret,
  socket: join(data, "app.sqlite.sock"),
});
export const close = async () => {
  await web.close();
  await generation.close();
};
signalReady(web.origin);
