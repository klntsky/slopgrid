import type { Grid } from "../domain.js";
import { Router } from "express";
import { token } from "../ids.js";
import { anonymousOwner, type SessionReader } from "../session.js";
import type { Store } from "../store.js";
import type { Jobs } from "../jobs.js";
import type { RateLimiter } from "../rate-limit.js";
import { oauthReturnTo, oauthVerifier, type OAuthProvider } from "../oauth.js";

export function createIdentityRoutes(
  store: Store,
  jobs: Jobs,
  save: (grid: Grid) => void,
  session: SessionReader,
  rate: RateLimiter,
  origin: string,
  providers: readonly OAuthProvider[],
) {
  const routes = Router();
  routes.post("/api/auth/logout", (req, res) => {
    const s = session(req, res);
    session.rotate(s, res);
    res.json({ user: null });
  });
  for (const provider of providers) {
    const callback = `${origin}/api/auth/${provider.id}/callback`;
    routes.get(`/api/auth/${provider.id}/start`, (req, res) => {
      const s = session(req, res);
      if (!rate(`identity:${s.id}`, 20))
        return res
          .status(429)
          .send("Too many sign-in attempts. Try again later.");
      const pending = {
        provider: provider.id,
        verifier: oauthVerifier(),
        state: token(),
        startedAt: Date.now(),
        returnTo: oauthReturnTo(req.query.returnTo),
      };
      s.identityOAuth = pending;
      store.saveSession(s);
      res.redirect(
        provider.authorizationURL(callback, pending.state, pending.verifier),
      );
    });
    routes.get(`/api/auth/${provider.id}/callback`, async (req, res) => {
      const s = session(req, res),
        pending = s.identityOAuth;
      if (
        !pending ||
        pending.provider !== provider.id ||
        typeof req.query.state !== "string" ||
        req.query.state !== pending.state ||
        Date.now() - pending.startedAt > 600000
      )
        return res
          .status(400)
          .send("Sign-in expired or was cancelled. Sign in again.");
      delete s.identityOAuth;
      store.saveSession(s);
      const failed = `${pending.returnTo}?signin=failed`;
      if (
        typeof req.query.code !== "string" ||
        !req.query.code ||
        req.query.error
      )
        return res.redirect(failed);
      try {
        const profile = await provider.identity(
          req.query.code,
          pending.verifier,
          callback,
        );
        // A logout, account switch, or new sign-in during exchange invalidates this result.
        const current = store.session(s.id);
        if (!current || current.identityOAuth || current.userId !== s.userId)
          return res.redirect(failed);
        store.db.transaction(() => {
          const user = store.identify(
            provider.id,
            profile.subject,
            profile.identity,
          );
          const owner = anonymousOwner(current);
          store.claim(owner, user.id);
          for (const grid of jobs.active.values())
            if (grid.owner === owner && !grid.ownerUserId) {
              grid.ownerUserId = user.id;
              save(grid);
            }
          session.rotate(current, res, user.id);
        })();
        res.redirect(pending.returnTo);
      } catch {
        res.redirect(failed);
      }
    });
  }
  return routes;
}
