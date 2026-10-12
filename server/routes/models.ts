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
  app.get("/api/models/image-capabilities", async (req, res) => {
    if (typeof req.query.model !== "string")
      return res.status(400).json({ error: "Select an image model" });
    try {
      res.json(await provider.imageCapabilities(req.query.model));
    } catch {
      res.status(502).json({ error: "Could not load image capabilities" });
    }
  });
  return app;
}
