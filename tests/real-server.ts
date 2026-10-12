import { startGenerationFixture } from "./generation-fixture.js";
import { createFrontendRoutes } from "../server/frontend.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createApp } from "../server/app.js";
const port = Number(process.env.E2E_PORT ?? 4317);
const data = process.env.FIXTURE_DATA!;
const secret = randomBytes(32);
const generation = await startGenerationFixture({
  database: join(data, "app.sqlite"),
  secret,
});
const { app } = createApp({
  origin: `http://localhost:${port}`,
  outputDomain: `-slopgrid.localhost:${port}`,
  database: join(data, "app.sqlite"),
  outputsPath: join(data, "outputs"),
  secret,
  generation: generation.api,
});
app.use(createFrontendRoutes("dist"));
app.listen(port, () => console.log("Real-provider app ready"));
