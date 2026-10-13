import { Router } from "express";
import type { ModelCatalog } from "../model-catalog.js";

export function createModelRoutes(catalog: ModelCatalog) {
  const app = Router();
  app.get("/api/models", async (_req, res) => {
    try {
      res.json(await catalog.read());
    } catch {
      res
        .status(502)
        .json({ error: "Could not load OpenRouter models. Try again." });
    }
  });
  return app;
}
