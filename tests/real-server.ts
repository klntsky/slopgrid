import { signalReady } from "./process-ready.js";
import { startGenerationFixture } from "./generation-fixture.js";
import { webFixture } from "./web-fixture.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
const port = Number(process.env.E2E_PORT ?? 4317);
const data = process.env.FIXTURE_DATA!;
const secret = randomBytes(32);
const generation = await startGenerationFixture({
  database: join(data, "app.sqlite"),
  secret,
});
const web = await webFixture({
  directory: data,
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
