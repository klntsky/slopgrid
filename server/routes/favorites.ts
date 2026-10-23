import { Router, type Request, type Response } from "express";
import { createFavorites, type AccountViewer } from "../favorites.js";
import type { SessionReader } from "../session.js";
import type { Store } from "../store.js";

export function createFavoriteRoutes(store: Store, session: SessionReader) {
  const routes = Router();
  const favorites = createFavorites(store);
  function account(req: Request, res: Response): AccountViewer | undefined {
    const viewer = session(req, res);
    if (!viewer.userId) {
      res
        .status(401)
        .json({ error: "Sign in with GitHub to manage favorites." });
      return;
    }
    return { ...viewer, userId: viewer.userId };
  }
  routes.get("/api/favorites/ids", (req, res) => {
    const viewer = account(req, res);
    if (viewer) res.json(favorites.ids({ viewer }));
  });
  routes.get("/api/favorites", (req, res) => {
    const viewer = account(req, res);
    if (!viewer) return;
    const value = req.query.page ?? "1";
    const page =
      typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : NaN;
    if (!Number.isSafeInteger(page))
      return res.status(400).json({ error: "Invalid page" });
    res.json(favorites.page({ viewer, page }));
  });
  routes.route("/api/favorites/:gridId").put(set).delete(set);
  function set(req: Request, res: Response) {
    const viewer = account(req, res);
    if (!viewer) return;
    const gridId = String(req.params.gridId);
    if (!/^[a-f0-9]{48}$/.test(gridId))
      return res.status(400).json({ error: "Invalid grid ID" });
    const result = favorites.set({
      viewer,
      gridId,
      starred: req.method === "PUT",
    });
    if (result.kind === "not-found")
      return res.status(404).json({ error: "Grid not found" });
    res.json(result.value);
  }
  return routes;
}
