import { Router } from "express";
import { startOAuth, validOAuth, codeChallenge } from "../oauth.js";
import type { Store } from "../store.js";
import type { Provider } from "../provider.js";
import { presentSession, type SessionReader } from "../session.js";
import type { RateLimiter } from "../rate-limit.js";

export function createAuthRoutes({
  store,
  provider,
  session,
  rate,
  origin,
  authURL,
}: {
  store: Store;
  provider: Provider;
  session: SessionReader;
  rate: RateLimiter;
  origin: string;
  authURL?: string;
}) {
  const app = Router();
  app.get("/api/session", (req, res) => {
    res.json(presentSession({ store, viewer: session(req, res) }));
  });
  app.delete("/api/session/key", (req, res) => {
    const s = session(req, res);
    delete s.key;
    store.saveSession(s);
    res.json({ connected: false });
  });
  app.get("/api/auth/start", async (req, res) => {
    const s = session(req, res);
    if (!rate(`oauth:${s.id}`, 20))
      return res
        .status(429)
        .send("Too many connection attempts. Try again later.");
    const pending = startOAuth("openrouter", req.query.returnTo);
    s.keyOAuth = pending;
    store.saveSession(s);
    const url = new URL(authURL ?? "https://openrouter.ai/auth");
    url.searchParams.set("callback_url", `${origin}/api/auth/callback`);
    url.searchParams.set("state", pending.state);
    url.searchParams.set(
      "code_challenge",
      await codeChallenge(pending.verifier),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("key_label", "slopgrid");
    res.redirect(url.href);
  });
  app.get("/api/auth/callback", async (req, res) => {
    const s = session(req, res),
      pending = s.keyOAuth;
    if (
      !pending ||
      !validOAuth(pending, req.query.state) ||
      typeof req.query.code !== "string" ||
      !req.query.code ||
      req.query.error
    )
      return res
        .status(400)
        .send(
          "Connection expired or was cancelled. Return to settings and connect again.",
        );
    const { verifier, returnTo } = pending;
    delete s.keyOAuth;
    store.saveSession(s);
    try {
      const key = await provider.exchangeKey(req.query.code, verifier);
      const current = store.session(s.id);
      if (!current || current.keyOAuth)
        return res.redirect(`${returnTo}?connection=failed`);
      current.key = key;
      store.saveSession(current);
      res.redirect(returnTo);
    } catch {
      res.redirect(`${returnTo}?connection=failed`);
    }
  });
  return app;
}
