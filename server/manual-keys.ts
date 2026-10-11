import { Router, type Request } from "express";
import { z } from "zod";
import type { Provider } from "./provider.js";
import type { SessionReader } from "./session.js";
import type { RateLimiter } from "./rate-limit.js";
import { upstreamFetch } from "./http.js";

export function manualKey(req: Request): string | undefined {
  const header = req.get("authorization");
  return header === undefined
    ? undefined
    : (header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "");
}
class InvalidKey extends Error {}
async function keyInfo(provider: Provider, key: string) {
  const response = await upstreamFetch(`${provider.baseURL}/key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status === 401 || response.status === 403)
    throw new InvalidKey();
  if (!response.ok) throw new Error("Key lookup failed");
  return z
    .object({
      data: z.object({
        limit_remaining: z.number().finite().nullable().optional(),
      }),
    })
    .parse(await response.json()).data;
}
export async function manualCredits(
  provider: Provider,
  key: string,
): Promise<number | null> {
  const info = await keyInfo(provider, key);
  const response = await upstreamFetch(`${provider.baseURL}/credits`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status === 403) return info.limit_remaining ?? null;
  if (!response.ok) throw new Error("Credit lookup failed");
  const { data } = z
    .object({
      data: z.object({
        total_credits: z.number().finite(),
        total_usage: z.number().finite(),
      }),
    })
    .parse(await response.json());
  const balance = data.total_credits - data.total_usage;
  return info.limit_remaining === undefined || info.limit_remaining === null
    ? balance
    : Math.min(balance, info.limit_remaining);
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
      await keyInfo(provider, key);
      res.json({ connected: true });
    } catch (error) {
      res
        .status(error instanceof InvalidKey ? 401 : 502)
        .json({
          error:
            error instanceof InvalidKey
              ? "Invalid OpenRouter API key."
              : "Could not verify OpenRouter API key.",
        });
    }
  });
  return routes;
}
