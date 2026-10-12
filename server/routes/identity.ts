import { Router } from "express";
import { anonymousOwner, type SessionReader } from "../session.js";
import type { Store } from "../store.js";
import type { RateLimiter } from "../rate-limit.js";
import { startOAuth, validOAuth, type OAuthProvider } from "../oauth.js";

export function createIdentityRoutes(
  store: Store,
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
    routes.get(`/api/auth/${provider.id}/start`, async (req, res) => {
      const s = session(req, res);
      if (!rate(`identity:${s.id}`, 20))
        return res
          .status(429)
          .send("Too many sign-in attempts. Try again later.");
      const pending = startOAuth(provider.id, req.query.returnTo);
      s.identityOAuth = pending;
      store.saveSession(s);
      res.redirect(
        await provider.authorizationURL(
          callback,
          pending.state,
          pending.verifier,
        ),
      );
    });
    routes.get(`/api/auth/${provider.id}/callback`, async (req, res) => {
      const s = session(req, res),
        pending = s.identityOAuth;
      if (
        !pending ||
        pending.provider !== provider.id ||
        !validOAuth(pending, req.query.state)
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
      let stage = "identity";
      try {
        const profile = await provider.identity(
          new URL(req.originalUrl, origin).searchParams,
          pending.verifier,
          callback,
          pending.state,
        );
        // A logout, account switch, or new sign-in during exchange invalidates this result.
        const current = store.session(s.id);
        if (!current || current.identityOAuth || current.userId !== s.userId) {
          console.error("Sign-in failed", {
            provider: provider.id,
            stage: "session changed",
          });
          return res.redirect(failed);
        }
        stage = "account update";
        store.db.transaction(() => {
          const user = store.identify(
            provider.id,
            profile.subject,
            profile.identity,
          );
          const owner = anonymousOwner(current);
          store.claim(owner, user.id);
          session.rotate(current, res, user.id);
        })();
        res.redirect(pending.returnTo);
      } catch (error) {
        const details = (error instanceof Error ? error : {}) as {
          code?: string;
          error?: string;
          status?: number;
          cause?: { code?: string; status?: number; body?: { error?: string } };
        };
        const code = details.code ?? details.cause?.code;
        const upstream = details.error ?? details.cause?.body?.error;
        // Never log the exception, message, callback, response body, or credentials.
        console.error("Sign-in failed", {
          provider: provider.id,
          stage,
          code:
            code &&
            /^(OAUTH_|ERR_|SQLITE_|UND_ERR_|GITHUB_|E)[A-Z_0-9]{1,64}$/.test(
              code,
            )
              ? code
              : undefined,
          status: details.status ?? details.cause?.status,
          upstream: [
            "incorrect_client_credentials",
            "redirect_uri_mismatch",
            "bad_verification_code",
            "invalid_client",
            "invalid_grant",
            "access_denied",
          ].includes(upstream ?? "")
            ? upstream
            : undefined,
          type:
            error instanceof Error ? error.constructor.name : "UnknownError",
        });
        res.redirect(failed);
      }
    });
  }
  return routes;
}
