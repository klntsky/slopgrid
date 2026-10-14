import express from "express";
import { createServer } from "node:http";
import { chmodSync } from "node:fs";
import { once } from "node:events";
import { recoverableStorageError } from "./persistence.js";
import {
  generationProtocol,
  generationErrorStatus,
  generationError,
  startGridRequest,
  pauseGridRequest,
  previewRequest,
  type GenerationAPI,
} from "./generation-api.js";

export async function serveGeneration(api: GenerationAPI, socket: string) {
  const app = express();
  app.use((_req, res, next) => {
    res.set("X-Generation-Protocol", String(generationProtocol));
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.get("/v1/status", async (_req, res) => {
    res.json(await api.status());
  });
  app.post("/v1/drain", async (_req, res) => {
    res.json(await api.drain());
  });
  app.post("/v1/accept", async (_req, res) => {
    res.json(await api.accept());
  });
  app.post("/v1/grids/start", async (req, res) => {
    res.json(await api.startGrid(startGridRequest.parse(req.body)));
  });
  app.post("/v1/grids/pause", async (req, res) => {
    res.json(await api.pauseGrid(pauseGridRequest.parse(req.body)));
  });
  app.get("/v1/grids/:id", async (req, res) => {
    res.json(await api.getGrid(String(req.params.id)));
  });
  app.post("/v1/previews/path", async (req, res) => {
    res.json({
      path: (await api.previewPath(previewRequest.parse(req.body))) ?? null,
    });
  });
  app.get("/v1/grids/:id/events", async (req, res) => {
    const id = String(req.params.id);
    await api.getGrid(id);
    res.type("application/x-ndjson").set("Cache-Control", "no-store");
    res.flushHeaders();
    const unsubscribe = api.subscribeGrid(
      id,
      (grid) => {
        // Disconnect slow consumers rather than retaining unbounded draft snapshots.
        if (res.writableNeedDrain) res.destroy();
        else res.write(JSON.stringify(grid) + "\n");
      },
      () => res.end(),
    );
    res.on("close", () => {
      unsubscribe();
    });
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ code: "NOT_FOUND", error: "Unknown generation endpoint" }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const parsed = generationError.safeParse({
        code: (error as { code?: string })?.code,
        error:
          error instanceof Error ? error.message : "Invalid generation request",
      });
      if (
        !parsed.success &&
        !recoverableStorageError(error) &&
        !(error instanceof Error && error.name === "ZodError") &&
        !(error as { status?: number })?.status
      ) {
        console.error(
          "Generation request failed",
          error instanceof Error ? error.name : "unknown",
          (error as { code?: string })?.code,
        );
        res
          .status(500)
          .json({
            code: "UNAVAILABLE",
            error: "Generation service is unavailable.",
          });
        return;
      }
      const body = recoverableStorageError(error)
        ? {
            code: "PERSISTENCE_UNAVAILABLE" as const,
            error: "Generation storage is temporarily unavailable.",
          }
        : parsed.success
          ? parsed.data
          : {
              code: "INVALID_REQUEST" as const,
              error: "Invalid generation request",
            };
      res.status(generationErrorStatus[body.code]).json(body);
    },
  );
  const server = createServer(app);
  server.listen(socket);
  await once(server, "listening");
  chmodSync(socket, 0o600);
  return server;
}
