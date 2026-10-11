import { Router, type Request } from "express";
import { InvalidKey, type Provider } from "./provider.js";
import type { SessionReader } from "./session.js";
import type { RateLimiter } from "./rate-limit.js";

export function manualKey(req: Request): string | undefined {
  const header = req.get("authorization");
  return header === undefined
    ? undefined
    : (header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "");
}
export function createManualKeyRoutes(
  provider: Provider,
  session: SessionReader,
  rate: RateLimiter,
) {
  const routes = Router();
  routes.post("/api/auth/key", async (req, res) => {
    const owner = session(req, res);
    if (!rate(`oauth:${owner.id}`, 20))
      return res
        .status(429)
        .json({ error: "Too many connection attempts. Try again later." });
    const key = manualKey(req);
    if (!key) return res.status(400).json({ error: "Enter an API key." });
    try {
      await provider.keyInfo(key);
      res.json({ connected: true });
    } catch (error) {
      res.status(error instanceof InvalidKey ? 401 : 502).json({
        error:
          error instanceof InvalidKey
            ? "Invalid OpenRouter API key."
            : "Could not verify OpenRouter API key.",
      });
    }
  });
  return routes;
}
