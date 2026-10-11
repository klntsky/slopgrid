import { EventEmitter } from "node:events";
import type { Grid } from "./domain.js";
import {
  githubCredentials,
  githubProvider,
  type OAuthCredentials,
} from "./oauth.js";
import { createIdentityRoutes } from "./routes/identity.js";
import { createBillingRoutes } from "./routes/billing.js";
import express from "express";
import { Store } from "./store.js";
import { Provider } from "./provider.js";
import { Jobs } from "./jobs.js";
import { createHtmlHosts } from "./hosts.js";
import { createHostDispatcher } from "./hosting.js";
import { createApiSecurity } from "./security.js";
import { createRateLimiter } from "./rate-limit.js";
import { createSessionReader } from "./session.js";
import { createGridPresenter } from "./grid-presentation.js";
import { createOutputRoutes } from "./routes/outputs.js";
import { createManualKeyRoutes } from "./manual-keys.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createModelRoutes } from "./routes/models.js";
import { createGridRoutes } from "./routes/grids.js";
import { createEventRoutes } from "./routes/events.js";
export type Config = {
  github?: OAuthCredentials;
  origin: string;
  outputDomain: string;
  database: string;
  secret: Buffer;
  outputsPath?: string;
  provider?: Provider;
  authURL?: string;
  workersMax?: number;
};

export function createApp(config: Config) {
  const credentials = githubCredentials(
    config.github?.clientId ?? process.env.GITHUB_CLIENT_ID,
    config.github?.clientSecret ?? process.env.GITHUB_CLIENT_SECRET,
  );
  const app = express();
  const store = new Store(config.database, config.secret, config.outputsPath);
  const provider = config.provider ?? new Provider();
  const updates = new EventEmitter().setMaxListeners(0);
  const save = (grid: Grid) => {
    store.save(grid);
    updates.emit(grid.id, grid);
  };
  const jobs = new Jobs(store, provider, config.workersMax, save);
  const origin = new URL(config.origin);
  const htmlHosts = createHtmlHosts(origin, config.outputDomain);
  const rate = createRateLimiter();
  const session = createSessionReader(store, origin);
  const snapshot = createGridPresenter(store, origin, htmlHosts);
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(createHostDispatcher(store, origin, htmlHosts, rate, jobs.previews));
  app.use(createOutputRoutes(store, origin, rate));
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", createApiSecurity(config.origin, rate));
  app.use(
    createAuthRoutes({
      store,
      provider,
      session,
      rate,
      origin: config.origin,
      authURL: config.authURL,
    }),
  );
  app.use(
    createIdentityRoutes(store, jobs, save, session, rate, origin.origin, [
      githubProvider(credentials),
    ]),
  );
  app.use(createManualKeyRoutes(provider, session, rate));
  app.use(createModelRoutes(provider));
  app.use(createBillingRoutes(store, session));
  app.use(
    createGridRoutes({ store, provider, jobs, session, rate, snapshot, save }),
  );
  app.use(createEventRoutes({ store, jobs, session, snapshot, updates }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "Invalid request" });
    },
  );
  return { app, store, jobs };
}
