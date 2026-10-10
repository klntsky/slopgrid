import { Router } from "express";
import type { Provider } from "../provider.js";

export function createModelRoutes(provider: Provider) {
  const app = Router();
  app.get("/api/models", async (_req, res) => {
    try {
      res.json(await provider.models());
    } catch {
      res
        .status(502)
        .json({ error: "Could not load OpenRouter models. Try again." });
    }
  });
  return app;
}
