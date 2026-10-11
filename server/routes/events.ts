import { Router } from "express";
import type { Store } from "../store.js";
import type { Jobs } from "../jobs.js";
import type { Grid } from "../domain.js";
import type { SessionReader } from "../session.js";
import type { GridPresenter } from "../grid-presentation.js";
import { canViewGrid } from "../grid-presentation.js";

export function createEventRoutes({
  store,
  jobs,
  session,
  snapshot,
}: {
  store: Store;
  jobs: Jobs;
  session: SessionReader;
  snapshot: GridPresenter;
}) {
  const app = Router();
  const connections = new Map<string, number>();
  app.get("/api/grids/:id/events", (req, res) => {
    const s = session(req, res),
      id = String(req.params.id),
      g = store.get(id);
    if (!g || !canViewGrid(g, s)) return res.sendStatus(404);
    if (
      (connections.get(s.id) ?? 0) >= 5 ||
      [...connections.values()].reduce((a, b) => a + b, 0) >= 100
    )
      return res.sendStatus(429);
    connections.set(s.id, (connections.get(s.id) ?? 0) + 1);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (grid: Grid) => {
      const current = store.session(s.id);
      if (!current || !canViewGrid(grid, current)) {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(snapshot(grid, current))}\n\n`);
    };
    send(jobs.active.get(id) ?? g);
    const unsubscribe = jobs.subscribe(id, send),
      heartbeat = setInterval(() => {
        if (!store.session(s.id)) res.end();
        else res.write(": heartbeat\n\n");
      }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      const remaining = (connections.get(s.id) ?? 1) - 1;
      if (remaining) connections.set(s.id, remaining);
      else connections.delete(s.id);
    });
  });
  return app;
}
