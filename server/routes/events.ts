import type { EventEmitter } from "node:events";
import { Router } from "express";
import type { Store } from "../store.js";
import type { GenerationAPI } from "../generation-api.js";
import type { Grid } from "../domain.js";
import type { SessionReader } from "../session.js";
import type { GridPresenter } from "../grid-presentation.js";
import { canViewGrid } from "../grid-policy.js";

export function createEventRoutes({
  store,
  generation,
  session,
  snapshot,
  updates,
}: {
  store: Store;
  generation: GenerationAPI;
  session: SessionReader;
  snapshot: GridPresenter;
  updates: EventEmitter;
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
    let revision = -1;
    const send = (grid: Grid) => {
      const current = store.session(s.id),
        stored = store.get(id);
      if (!current || !stored || !canViewGrid(stored, current)) {
        res.end();
        return;
      }
      if (grid.revision < revision) return;
      revision = grid.revision;
      if (res.writableNeedDrain) {
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify(snapshot(grid, current))}\n\n`);
    };
    updates.on(id, send);
    const unsubscribe = generation.subscribeGrid(id, send, () => res.end());
    const heartbeat = setInterval(() => {
      if (!store.session(s.id)) res.end();
      else res.write(": heartbeat\n\n");
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      updates.off(id, send);
      unsubscribe();
      const remaining = (connections.get(s.id) ?? 1) - 1;
      if (remaining) connections.set(s.id, remaining);
      else connections.delete(s.id);
    });
  });
  return app;
}
