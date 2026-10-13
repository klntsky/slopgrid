import { createReferenceRoutes } from "./routes/references.js";
import { EventEmitter } from "node:events";
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
import { type GenerationAPI, generationErrorStatus } from "./generation-api.js";
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
import { createOutputAccess } from "./output-access.js";
export type Config = {
  github?: OAuthCredentials;
  origin: string;
  outputDomain: string;
  database: string;
  secret: Buffer;
  outputsPath?: string;
  provider?: Provider;
  authURL?: string;
  generation: GenerationAPI;
};

export function createApp(config: Config) {
  const credentials = githubCredentials(
    config.github?.clientId ?? process.env.GITHUB_CLIENT_ID,
    config.github?.clientSecret ?? process.env.GITHUB_CLIENT_SECRET,
  );
  const app = express();
  const store = new Store(config.database, config.secret, config.outputsPath);
  const provider =
    config.provider ?? new Provider(process.env.OPENROUTER_BASE_URL);
  const updates = new EventEmitter().setMaxListeners(0);
  const generation = config.generation;
  const origin = new URL(config.origin);
  const htmlHosts = createHtmlHosts(origin, config.outputDomain);
  const rate = createRateLimiter();
  const session = createSessionReader(store, origin);
  const outputAccess = createOutputAccess(
    store,
    session,
    htmlHosts,
    config.secret,
  );
  const snapshot = createGridPresenter(store, origin);
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(
    createHostDispatcher(
      store,
      origin,
      htmlHosts,
      rate,
      generation,
      outputAccess,
    ),
  );
  app.use(createOutputRoutes(store, origin, rate, session));
  app.get("/outputs/:id/website", outputAccess.open);
  app.use(express.json({ limit: Infinity }));
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
    createIdentityRoutes(store, session, rate, origin.origin, [
      githubProvider(credentials),
    ]),
  );
  app.use(createManualKeyRoutes(provider, session, rate));
  app.use(createModelRoutes(provider));
  app.use(createReferenceRoutes(store, session));
  app.use(createBillingRoutes(store, session));
  app.use(
    createGridRoutes({
      store,
      provider,
      generation,
      session,
      rate,
      snapshot,
      updates,
    }),
  );
  app.use(createEventRoutes({ store, generation, session, snapshot, updates }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const code = (error as { code?: keyof typeof generationErrorStatus })
        ?.code;
      if (code && Object.hasOwn(generationErrorStatus, code))
        res
          .status(generationErrorStatus[code])
          .json({ code, error: (error as Error).message });
      else res.status(400).json({ error: "Invalid request" });
    },
  );
  return { app, store };
}
