import { z } from "zod";
import { manualKey } from "../manual-keys.js";
import { Router } from "express";
import type { Store } from "../store.js";
import type { Provider } from "../provider.js";
import type { Jobs } from "../jobs.js";
import type { SessionReader } from "../session.js";
import type { RateLimiter } from "../rate-limit.js";
import type { GridPresenter } from "../grid-presentation.js";
import { anonymousOwner } from "../session.js";
import { canViewGrid, ownsGrid } from "../grid-presentation.js";
import {
  gridSchema,
  expandGrid,
  type Grid,
  type GridSummary,
} from "../domain.js";
import {
  ModelResolutionError,
  resolveGridModels,
} from "../model-resolution.js";
import { createInferenceGuard } from "../inference-policy.js";
import { token } from "../ids.js";

export function createGridRoutes({
  store,
  provider,
  jobs,
  session,
  rate,
  snapshot,
}: {
  store: Store;
  provider: Provider;
  jobs: Jobs;
  session: SessionReader;
  rate: RateLimiter;
  snapshot: GridPresenter;
}) {
  const app = Router(),
    allowInference = createInferenceGuard(store, provider);
  const summary = (g: Grid): GridSummary => ({
    id: g.id,
    prompt: g.input.prompt,
    format: g.input.format,
    status: g.status,
    published: g.published,
    visibility: g.visibility,
    author: store.author(g),
  });
  app.get("/api/grids/public", (_req, res) => {
    res.json(
      store
        .all()
        .filter((g) => g.visibility === "public")
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        )
        .map(summary),
    );
  });
  app.get("/api/grids", (req, res) => {
    const s = session(req, res);
    res.json(
      store
        .all()
        .filter((g) => ownsGrid(g, s))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(summary),
    );
  });
  app.post("/api/grids", async (req, res) => {
    const s = session(req, res);
    const suppliedKey = manualKey(req);
    if (!(suppliedKey ?? s.key))
      return res
        .status(401)
        .json({ error: "Connect OpenRouter before generating." });
    const parsed = gridSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    let input: Grid["input"];
    try {
      input = resolveGridModels(parsed.data, await provider.models());
    } catch (error) {
      return res
        .status(error instanceof ModelResolutionError ? 400 : 502)
        .json({
          error:
            error instanceof ModelResolutionError
              ? error.message
              : "Could not load OpenRouter models. Try again.",
        });
    }
    if (!(await allowInference(req, res, s))) return;
    const cells = expandGrid(input).map((c) => ({ ...c, id: token() }));
    if (!rate(`create:${s.id}`, 10) || !rate(`create-ip:${req.ip}`, 30))
      return res
        .status(429)
        .json({ error: "Grid limit reached. Try again in an hour." });
    const g: Grid = {
      revision: 0,
      id: token(),
      owner: anonymousOwner(s),
      ownerUserId: s.userId,
      input,
      status: "running",
      published: false,
      visibility: "private",
      cells,
      createdAt: new Date().toISOString(),
    };
    store.save(g);
    jobs.start(g, suppliedKey, s);
    res.status(201).json(snapshot(g, s));
  });
  app.get("/api/grids/:id", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !canViewGrid(g, s))
      return res.status(404).json({ error: "Grid not found" });
    res.json(snapshot(jobs.active.get(g.id) ?? g, s));
  });
  app.post("/api/grids/:id/retry", async (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !ownsGrid(g, s))
      return res.status(404).json({ error: "Grid not found" });
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids cannot be changed." });
    const suppliedKey = manualKey(req);
    if (!(suppliedKey ?? s.key))
      return res
        .status(401)
        .json({ error: "Reconnect OpenRouter to continue." });
    const current = jobs.active.get(g.id);
    if (current?.status === "running") return res.json(snapshot(current, s));
    if (
      g.cells.some((c) => c.status !== "complete") &&
      !(await allowInference(req, res, s))
    )
      return;
    if (!rate(`retry:${s.id}`, 30))
      return res
        .status(429)
        .json({ error: "Retry limit reached. Try again in an hour." });
    const resumed = g.cells.some((c) => c.status !== "complete")
      ? jobs.start(g, suppliedKey, s)
      : g;
    res.json(snapshot(resumed, s));
  });
  app.post("/api/grids/:id/pause", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !ownsGrid(g, s))
      return res.status(404).json({ error: "Grid not found" });
    if (g.published || g.status === "complete")
      return res
        .status(409)
        .json({ error: "This grid has finished generating." });
    res.json(snapshot(jobs.pause(g), s));
  });
  app.post("/api/grids/:id/edit", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !ownsGrid(g, s))
      return res.status(404).json({ error: "Grid not found" });
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids can only be forked." });
    res.json(snapshot(jobs.pause(g), s));
  });
  app.post("/api/grids/:id/publish", (req, res) => {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (!g || !ownsGrid(g, s))
      return res.status(404).json({ error: "Grid not found" });
    const parsed = z
      .object({
        visibility: z.enum(["private", "unlisted", "public"]),
      })
      .safeParse(
        req.body === undefined ? { visibility: "unlisted" } : req.body,
      );
    if (!parsed.success)
      return res.status(400).json({ error: "Choose a valid visibility." });
    const { visibility } = parsed.data;
    if (g.published) {
      if (visibility === g.visibility) return res.json(snapshot(g, s));
      if (g.visibility === "unlisted" && visibility === "public") {
        g.visibility = visibility;
        jobs.emit(g);
        return res.json(snapshot(g, s));
      }
      return res
        .status(409)
        .json({ error: "Published grid visibility cannot be changed." });
    }
    if (visibility === "private") return res.json(snapshot(g, s));
    if (
      g.cells.some(
        (cell) => cell.status !== "complete" && cell.status !== "error",
      )
    )
      return res
        .status(409)
        .json({ error: "Wait for every cell to finish before publishing." });
    const user = s.userId ? store.user(s.userId) : undefined;
    g.author = user
      ? {
          provider: user.provider,
          username: user.username,
          profileURL: user.profileURL,
        }
      : null;
    g.published = true;
    g.visibility = visibility;
    jobs.emit(g);
    res.json(snapshot(g, s));
  });
  return app;
}
