import type { RequestHandler } from "express";
import type { RateLimiter } from "./rate-limit.js";

export function createApiSecurity(
  origin: string,
  rate: RateLimiter,
): RequestHandler {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!rate(`api:${req.ip}`, 600, 60000)) {
      res.set("Retry-After", "60");
      return res
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      ((req.get("origin") && req.get("origin") !== origin) ||
        req.get("sec-fetch-site") === "cross-site")
    )
      return res.status(403).json({ error: "Request origin is not allowed" });
    next();
  };
}
