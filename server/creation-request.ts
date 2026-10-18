import { createHash } from "node:crypto";
import type { Store, Session } from "./store.js";
import type { Grid, WorkflowTask } from "./domain.js";
import { anonymousOwner } from "./session.js";
import { ownsGrid } from "./grid-policy.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function creationRequest(
  store: Store,
  session: Session,
  id: string,
  body: Record<string, unknown>,
) {
  const {
    creationRequestId: _id,
    continueWithLowBalance: _confirmation,
    ...input
  } = body;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
  const owner = anonymousOwner(session);
  function existing(): Grid | undefined {
    const row = store.db
      .prepare(
        "SELECT fingerprint, grid_id FROM creation_requests WHERE owner=? AND request_id=?",
      )
      .get(owner, id) as { fingerprint: string; grid_id: string } | undefined;
    if (!row) return;
    const grid = store.get(row.grid_id);
    if (!grid || !ownsGrid(grid, session))
      throw Object.assign(new Error("Grid not found"), { status: 404 });
    if (row.fingerprint !== fingerprint)
      throw Object.assign(new Error("Creation request has different inputs."), {
        status: 409,
      });
    return grid;
  }
  function insert(grid: Grid, tasks?: WorkflowTask[]) {
    return store.db
      .transaction(() => {
        const previous = existing();
        if (previous) return previous;
        store.insert(grid, tasks);
        store.db
          .prepare(
            "INSERT INTO creation_requests (owner, request_id, fingerprint, grid_id) VALUES (?,?,?,?)",
          )
          .run(owner, id, fingerprint, grid.id);
        return grid;
      })
      .immediate();
  }
  return { existing, insert };
}
