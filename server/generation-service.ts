import { EventEmitter } from "node:events";
import { token } from "./ids.js";
import { Jobs } from "./jobs.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { ownsGrid } from "./grid-policy.js";
import {
  generationFailure,
  generationProtocol,
  type GenerationAPI,
  type GenerationStatus,
} from "./generation-api.js";

export function createGenerationService(
  store: Store,
  provider: Provider,
  workersMax = 100,
) {
  const updates = new EventEmitter().setMaxListeners(0);
  const jobs = new Jobs(store, provider, workersMax, (grid) => {
    updates.emit(grid.id);
  });
  const instance = token();
  const status = (): GenerationStatus => ({
    protocol: generationProtocol,
    instance,
    ...jobs.status(),
  });
  const getGrid = (id: string) => {
    const grid = jobs.snapshot(id);
    if (!grid) throw generationFailure("NOT_FOUND", "Grid not found");
    return {
      ...grid,
      spentUsd: store.billing.gridSpent(grid.id, grid.cells),
    };
  };
  const authorized = (gridId: string, sessionId: string) => {
    const grid = getGrid(gridId),
      session = store.session(sessionId);
    if (!session || !ownsGrid(grid, session))
      throw generationFailure("NOT_FOUND", "Grid not found");
    if (grid.published)
      throw generationFailure(
        "PUBLISHED",
        "Published grids cannot be changed.",
      );
    return { grid, session };
  };
  const api: GenerationAPI = {
    async startGrid({ gridId, sessionId, manualKey }) {
      // The admission gate and initial state transition are synchronous with draining.
      // The immediate transaction also serializes starts against web publication.
      return store.db
        .transaction(() => {
          const { grid, session } = authorized(gridId, sessionId);
          if (jobs.isRunning(gridId) || grid.status === "complete") return grid;
          if (jobs.draining)
            throw generationFailure(
              "DRAINING",
              "Generation is temporarily unavailable during an update.",
            );
          if (!(manualKey ?? session.key))
            throw generationFailure(
              "AUTH_REQUIRED",
              "Reconnect OpenRouter to continue.",
            );
          jobs.start(grid, manualKey, session);
          return getGrid(gridId);
        })
        .immediate();
    },
    async pauseGrid({ gridId, sessionId }) {
      const { grid } = authorized(gridId, sessionId);
      jobs.pause(grid);
      return getGrid(gridId);
    },
    async getGrid(id) {
      return getGrid(id);
    },
    async previewPath({ cellId, path }) {
      return jobs.previews.path(cellId, path);
    },
    subscribeGrid(id, snapshot, disconnected) {
      const send = () => {
        try {
          snapshot(getGrid(id));
        } catch {
          disconnected();
        }
      };
      // Listener registration and the initial snapshot happen in the same turn.
      updates.on(id, send);
      send();
      return () => {
        updates.off(id, send);
      };
    },
    async status() {
      return status();
    },
    async drain() {
      jobs.draining = true;
      return status();
    },
    async accept() {
      jobs.draining = false;
      return status();
    },
  };
  return { api, jobs };
}
