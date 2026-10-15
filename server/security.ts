import type { RequestHandler } from "express";
import type { RateLimiter } from "./rate-limit.js";

export function createApiSecurity(
  origin: string,
  rate: RateLimiter,
): RequestHandler {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const catalogRead =
      ["GET", "HEAD"].includes(req.method) && req.path === "/models";
    if (!catalogRead && !rate(`api:${req.ip}`, 600, 60000)) {
      res.set("Retry-After", "60");
      return res
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
    }
    // OAuth providers return through top-level GET navigation. Other foreign
    // requests must not mutate sessions, including GET-based OAuth starts.
    const callback =
      req.method === "GET" &&
      /^\/auth\/(?:github\/)?callback$/.test(req.path) &&
      (!req.get("sec-fetch-mode") ||
        req.get("sec-fetch-mode") === "navigate") &&
      (!req.get("sec-fetch-dest") || req.get("sec-fetch-dest") === "document");
    if (
      !callback &&
      ((req.get("origin") && req.get("origin") !== origin) ||
        ["same-site", "cross-site"].includes(req.get("sec-fetch-site") ?? ""))
    )
      return res.status(403).json({ error: "Request origin is not allowed" });
    next();
  };
}
