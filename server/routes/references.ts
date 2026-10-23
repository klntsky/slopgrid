import { Router, raw, type ErrorRequestHandler } from "express";
import type { Store } from "../store.js";
import type { SessionReader } from "../session.js";

export function createReferenceRoutes(store: Store, session: SessionReader) {
  const routes = Router();
  routes.post(
    "/api/references",
    raw({ type: "application/octet-stream", limit: "20mb" }),
    (req, res) => {
      const name = typeof req.query.name === "string" ? req.query.name : "";
      if (
        !name ||
        name.length > 255 ||
        !Buffer.isBuffer(req.body) ||
        !req.body.length
      )
        return res.status(400).json({ error: "Choose an image file." });
      try {
        const image = store.references.add(req.body, name, session(req, res));
        if (!image)
          return res
            .status(400)
            .json({ error: "Choose a PNG, JPEG, or WebP image." });
        res.status(201).json(image);
      } catch (error) {
        console.error("Reference image upload failed", error);
        res.status(500).json({ error: "Could not upload image." });
      }
    },
  );
  routes.get("/api/references/:id", (req, res) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params.id);
    if (!store.references.allowed(id, session.read(req)))
      return res.sendStatus(404);
    const reference = store.references.get(id);
    const file = reference?.sha256 ? store.references.path(id) : undefined;
    if (!file || !reference) return res.sendStatus(404);
    res.set("X-Content-Type-Options", "nosniff");
    const etag = `"${reference.sha256}"`;
    res.set("ETag", etag);
    if (store.references.allowed(id)) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      // Keep bytes, but authorize every reuse, including after session revocation.
      res.vary("Cookie").set("Cache-Control", "private, no-cache");
    }
    // Explicit validation also handles a no-cache/no-store fetch. Express's
    // freshness shortcut otherwise treats that request as unconditionally stale.
    if (
      req
        .get("If-None-Match")
        ?.split(",")
        .some((value) => {
          const validator = value.trim().replace(/^W\//, "");
          return validator === "*" || validator === etag;
        })
    )
      return res.status(304).end();
    res.type(reference.mediaType).sendFile(file, {
      dotfiles: "allow",
      cacheControl: false,
      lastModified: false,
    });
  });
  const uploadError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === "entity.too.large")
      res.status(413).json({ error: "Image file is too large." });
    else next(error);
  };
  routes.use(uploadError);
  return routes;
}
