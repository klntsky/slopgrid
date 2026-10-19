import type { EventEmitter } from "node:events";
import { Router } from "express";
import type { Store } from "../store.js";
import type { GenerationAPI, GenerationSnapshot } from "../generation-api.js";
import type { SessionReader } from "../session.js";
import type { GridPresenter } from "../grid-presentation.js";
import { canViewGrid } from "../grid-policy.js";
import { compareGridVersions } from "../../shared/grid-version.js";
import { gridDelta } from "../../shared/grid-delta.js";
import { createStreamHistory } from "../stream-history.js";

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
  const history = createStreamHistory<ReturnType<GridPresenter>>();
  app.get("/api/grids/:id/events", (req, res) => {
    const s = session(req, res),
      id = String(req.params.id),
      g = store.get(id);
    if (!g || !canViewGrid(g, s)) return res.sendStatus(404);
    const incremental = req.query.protocol === "2";
    const scope = JSON.stringify([s.id, id]);
    let cursor = typeof req.query.since === "string" ? req.query.since : "";
    let previous = incremental ? history.get(cursor, scope) : undefined;
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
    let version = { epoch: 0, sequence: 0 };
    const send = (grid: GenerationSnapshot) => {
      const current = store.session(s.id),
        stored = store.get(id);
      if (!current || !stored || !canViewGrid(stored, current)) {
        res.end();
        return;
      }
      if (compareGridVersions(grid.version, version) < 0) return;
      version = grid.version;
      if (res.writableNeedDrain) {
        res.destroy();
        return;
      }
      const serialized = JSON.stringify(snapshot(grid, current));
      if (!incremental) {
        res.write(`data: ${serialized}\n\n`);
        return;
      }
      // Own an immutable JSON baseline: engine state can mutate after delivery.
      const next: ReturnType<GridPresenter> = JSON.parse(serialized);
      const message = previous
        ? {
            base: cursor,
            delta: gridDelta(previous, next) ?? { fields: {}, remove: [] },
          }
        : { snapshot: next };
      cursor = history.put(scope, next, Buffer.byteLength(serialized));
      previous = next;
      res.write(`id: ${cursor}\ndata: ${JSON.stringify(message)}\n\n`);
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
