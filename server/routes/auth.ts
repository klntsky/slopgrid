import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../store.js";
import type { Provider } from "../provider.js";
import type { SessionReader } from "../session.js";
import type { RateLimiter } from "../rate-limit.js";
import { token } from "../ids.js";
import { upstreamFetch } from "../http.js";

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
    const s = session(req, res);
    res.json({
      connected: !!s.key,
      user: s.userId ? (store.user(s.userId) ?? null) : null,
    });
  });
  app.delete("/api/session/key", (req, res) => {
    const s = session(req, res);
    delete s.key;
    store.saveSession(s);
    res.json({ connected: false });
  });
  app.get("/api/auth/start", (req, res) => {
    const s = session(req, res);
    if (!rate(`oauth:${s.id}`, 20))
      return res
        .status(429)
        .send("Too many connection attempts. Try again later.");
    s.verifier = randomBytes(32).toString("base64url");
    s.state = token();
    s.oauthAt = Date.now();
    const returnTo = String(req.query.returnTo ?? "/settings");
    s.returnTo = /^\/(?:settings|grid\/[a-f0-9]{48})?$/.test(returnTo)
      ? returnTo
      : "/settings";
    store.saveSession(s);
    const url = new URL(authURL ?? "https://openrouter.ai/auth");
    url.searchParams.set("callback_url", `${origin}/api/auth/callback`);
    url.searchParams.set("state", s.state);
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(s.verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("key_label", "slopgrid");
    res.redirect(url.href);
  });
  app.get("/api/auth/callback", async (req, res) => {
    const s = session(req, res);
    if (
      !s.verifier ||
      !s.state ||
      req.query.state !== s.state ||
      typeof req.query.code !== "string" ||
      Date.now() - (s.oauthAt ?? 0) > 600000
    )
      return res
        .status(400)
        .send(
          "Connection expired or was cancelled. Return to settings and connect again.",
        );
    const verifier = s.verifier,
      returnTo = s.returnTo ?? "/settings";
    delete s.verifier;
    delete s.state;
    delete s.oauthAt;
    delete s.returnTo;
    store.saveSession(s);
    try {
      const response = await upstreamFetch(`${provider.baseURL}/auth/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: req.query.code,
          code_verifier: verifier,
          code_challenge_method: "S256",
        }),
      });
      if (!response.ok) throw new Error("Exchange failed");
      const body = (await response.json()) as { key?: string };
      if (!body.key) throw new Error("Missing key");
      const current = store.session(s.id);
      if (!current) return res.redirect(`${returnTo}?connection=failed`);
      current.key = body.key;
      store.saveSession(current);
      res.redirect(returnTo);
    } catch {
      res.redirect(`${returnTo}?connection=failed`);
    }
  });
  return app;
}
