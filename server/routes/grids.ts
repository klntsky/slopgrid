import { reuseArtifacts } from "../artifact-reuse.js";
import { canViewGrid, ownsGrid } from "../grid-policy.js";
import { z } from "zod";
import { manualKey } from "../manual-keys.js";
import { Router, type Request, type Response } from "express";
import type { Store, Session } from "../store.js";
import type { Provider } from "../provider.js";
import type { GenerationAPI } from "../generation-api.js";
import type { EventEmitter } from "node:events";
import type { SessionReader } from "../session.js";
import type { RateLimiter } from "../rate-limit.js";
import type { GridPresenter } from "../grid-presentation.js";
import { anonymousOwner } from "../session.js";
import { gridAuthor, presentIdentity } from "../grid-presentation.js";
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
import {
  createInferenceGuard,
  inferenceCapacity,
} from "../inference-policy.js";
import { token } from "../ids.js";

export function createGridRoutes({
  store,
  provider,
  generation,
  session,
  rate,
  snapshot,
  updates,
}: {
  store: Store;
  provider: Provider;
  generation: GenerationAPI;
  session: SessionReader;
  rate: RateLimiter;
  snapshot: GridPresenter;
  updates: EventEmitter;
}) {
  const app = Router(),
    allowInference = createInferenceGuard(store, provider);
  const summary = (g: Grid): GridSummary => ({
    id: g.id,
    title: g.title,
    prompt: g.input.prompt,
    format: g.input.format,
    status: g.status,
    published: g.published,
    visibility: g.visibility,
    author: gridAuthor(g, store),
  });
  function readGrid(
    req: Request,
    res: Response,
    allowed: (grid: Grid, session: Session) => boolean = ownsGrid,
  ) {
    const s = session(req, res),
      g = store.get(String(req.params.id));
    if (g && allowed(g, s)) return { g, s };
    res.status(404).json({ error: "Grid not found" });
  }
  app.get("/api/inference-capacity", async (req, res) => {
    const s = session(req, res),
      supplied = manualKey(req),
      key = supplied ?? s.key;
    res.set("Cache-Control", "no-store");
    if (!key)
      return res
        .status(401)
        .json({ error: "Connect OpenRouter before generating." });
    if (!rate(`capacity:${s.id}`, 60, 60000))
      return res
        .status(429)
        .json({ error: "Too many balance checks. Try again shortly." });
    try {
      res.json(await inferenceCapacity(provider, key, supplied !== undefined));
    } catch {
      res
        .status(502)
        .json({ error: "Could not check your OpenRouter balance. Try again." });
    }
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
    const reuse = z
      .object({
        sourceGridId: z.string().min(1).optional(),
        reuseArtifacts: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!reuse.success)
      return res.status(400).json({ error: "Invalid artifact reuse request." });
    const source = reuse.data.sourceGridId
      ? store.get(reuse.data.sourceGridId)
      : undefined;
    if (reuse.data.sourceGridId && (!source || !canViewGrid(source, s)))
      return res.status(404).json({ error: "Grid not found" });
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
    if (
      Object.values(input.referenceGroups ?? {})
        .flat()
        .some((image) => !store.references.allowed(image.id, s))
    )
      return res
        .status(400)
        .json({ error: "A reference image is unavailable." });
    if (!(await allowInference(req, res, s, input.parallelWorkers))) return;
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
      status: "paused",
      published: false,
      visibility: "private",
      cells,
      createdAt: new Date().toISOString(),
    };
    if (source && reuse.data.reuseArtifacts)
      await reuseArtifacts(store, provider, source, input.format, cells);
    if (cells.every((cell) => cell.status === "complete"))
      g.status = "complete";
    store.insert(g);
    const started = await generation.startGrid({
      gridId: g.id,
      sessionId: s.id,
      manualKey: suppliedKey,
    });
    res.status(201).json(snapshot(started, s));
  });
  app.get("/api/grids/:id", async (req, res) => {
    const found = readGrid(req, res, canViewGrid);
    if (!found) return;
    const { g, s } = found;
    res.json(snapshot(await generation.getGrid(g.id), s));
  });
  app.patch("/api/grids/:id/title", async (req, res) => {
    const found = readGrid(req, res);
    if (!found) return;
    const parsed = z
      .object({ title: z.string().trim().max(40) })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Use a title of up to 40 characters." });
    const { g, s } = found;
    store.setTitle(g.id, parsed.data.title);
    const current = await generation.getGrid(g.id);
    updates.emit(g.id, current);
    res.json(snapshot(current, s));
  });
  app.post("/api/grids/:id/retry", async (req, res) => {
    const found = readGrid(req, res);
    if (!found) return;
    const { g, s } = found;
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids cannot be changed." });
    const suppliedKey = manualKey(req);
    if (!(suppliedKey ?? s.key))
      return res
        .status(401)
        .json({ error: "Reconnect OpenRouter to continue." });
    const current = await generation.getGrid(g.id);
    if (current.status === "running") return res.json(snapshot(current, s));
    if (
      g.cells.some((c) => c.status !== "complete") &&
      !(await allowInference(req, res, s, g.input.parallelWorkers))
    )
      return;
    if (!rate(`retry:${s.id}`, 30))
      return res
        .status(429)
        .json({ error: "Retry limit reached. Try again in an hour." });
    const resumed = g.cells.some((c) => c.status !== "complete")
      ? await generation.startGrid({
          gridId: g.id,
          sessionId: s.id,
          manualKey: suppliedKey,
        })
      : current;
    res.json(snapshot(resumed, s));
  });
  app.post("/api/grids/:id/pause", async (req, res) => {
    const found = readGrid(req, res);
    if (!found) return;
    const { g, s } = found;
    if (g.published || g.status === "complete")
      return res
        .status(409)
        .json({ error: "This grid has finished generating." });
    res.json(
      snapshot(
        await generation.pauseGrid({ gridId: g.id, sessionId: s.id }),
        s,
      ),
    );
  });
  app.post("/api/grids/:id/edit", async (req, res) => {
    const found = readGrid(req, res);
    if (!found) return;
    const { g, s } = found;
    if (g.published)
      return res
        .status(409)
        .json({ error: "Published grids can only be forked." });
    res.json(
      snapshot(
        await generation.pauseGrid({ gridId: g.id, sessionId: s.id }),
        s,
      ),
    );
  });
  app.post("/api/grids/:id/publish", async (req, res) => {
    const found = readGrid(req, res);
    if (!found) return;
    const { g, s } = found;
    const parsed = z
      .object({
        visibility: z.enum(["private", "unlisted", "public"]),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Choose a valid visibility." });
    const { visibility } = parsed.data;
    const error = store.publish(
      g.id,
      visibility,
      presentIdentity(s.userId ? store.user(s.userId) : undefined),
    );
    if (error) return res.status(409).json({ error });
    const current = await generation.getGrid(g.id);
    updates.emit(g.id, current);
    res.json(snapshot(current, s));
  });
  return app;
}
