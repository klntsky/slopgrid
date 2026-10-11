import { Router } from "express";
import type { Store } from "../store.js";
import type { SessionReader } from "../session.js";

export function createBillingRoutes(store: Store, session: SessionReader) {
  const routes = Router();
  routes.get("/api/billing", (req, res) => {
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      return res.status(400).json({ error: "Invalid page" });
    res.set("Cache-Control", "no-store");
    const s = session(req, res);
    res.json(store.billing.page(s.anonymousId ?? s.id, offset, s.userId));
  });
  return routes;
}
