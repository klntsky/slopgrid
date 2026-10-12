import { Router } from "express";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../../shared/markdown.js";
import type { Store } from "../store.js";
import type { RateLimiter } from "../rate-limit.js";
import { zip } from "fflate";
import { downloadFilename } from "../download-filename.js";
import { canViewGrid } from "../grid-policy.js";
import type { SessionReader } from "../session.js";
function outputFile(output: NonNullable<ReturnType<Store["outputMetadata"]>>) {
  if (output.format !== "image")
    return {
      html: {
        filename: "index.html",
        mediaType: "text/html",
        extension: "zip",
      },
      svg: {
        filename: "index.svg",
        mediaType: "image/svg+xml",
        extension: "svg",
      },
      markdown: {
        filename: "index.md",
        mediaType: "text/markdown",
        extension: "md",
      },
    }[output.format];
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  };
  return {
    filename: "image",
    mediaType: output.mediaType ?? "application/octet-stream",
    extension: extensions[output.mediaType ?? ""] ?? "bin",
  };
}
export function createOutputRoutes(
  store: Store,
  origin: URL,
  rate: RateLimiter,
  session: SessionReader,
) {
  const app = Router();
  app.use("/outputs/:id", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params.id);
    const output = /^[a-f0-9]{48}$/.test(id)
      ? store.outputMetadata(id)
      : undefined;
    if (!output || !canViewGrid(output, session.read(req)))
      return res.sendStatus(404);
    res.locals.output = output;
    res.locals.file = outputFile(output);
    next();
  });
  app.get("/outputs/:id/thinking/:attempt", (req, res) => {
    // A versioned URL cannot return a newer attempt under an older query key.
    const attempt = String(req.params.attempt);
    if (res.locals.output.thinkingId !== attempt) return res.sendStatus(404);
    const file = store.files.thinkingPath(String(req.params.id), attempt);
    if (!file) return res.sendStatus(404);
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    return res.type("text/plain").sendFile(file, { dotfiles: "allow" });
  });
  app.get("/outputs/:id/download", async (req, res) => {
    const id = String(req.params.id);
    if (!rate(`download:${req.ip}`, 100, 60000)) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many downloads. Try again in a minute.");
    }
    const output = store.outputDownload(id);
    if (!output) return res.sendStatus(404);
    const { filename, mediaType, extension } = res.locals.file as ReturnType<
      typeof outputFile
    >;
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    res.attachment(
      downloadFilename(
        output.prompt,
        output.gridId,
        output.row,
        output.column,
        extension,
      ),
    );
    if (output.format === "html") {
      const files = await store.files.bundle(id);
      const archive = await new Promise<Uint8Array>((resolve, reject) => {
        zip(files, { level: 6 }, (error, data) => {
          if (error) reject(error);
          else resolve(data);
        });
      });
      return res.type("application/zip").send(Buffer.from(archive));
    }
    const file = store.files.path(id, filename);
    if (!file) return res.sendStatus(404);
    return res.type(mediaType).sendFile(file, { dotfiles: "allow" });
  });
  app.get("/outputs/:id", (req, res) => {
    const id = String(req.params.id);
    if (!rate(`output:${req.ip}`, 2000, 60000)) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many requests. Try again in a minute.");
    }
    const output = res.locals.output as NonNullable<
      ReturnType<Store["outputMetadata"]>
    >;
    if (output.status !== "complete" || output.format === "html")
      return res.sendStatus(404);
    res.set(
      "Content-Security-Policy",
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin.origin}`,
    );
    const { filename, mediaType } = res.locals.file as ReturnType<
      typeof outputFile
    >;
    const file = store.files.path(id, filename);
    if (!file) return res.sendStatus(404);
    if (output.format !== "markdown" || req.query.raw === "1")
      return res
        .type(output.format === "markdown" ? "text/plain" : mediaType)
        .sendFile(file, { dotfiles: "allow" });
    const colorScheme =
      req.query.theme === "dark"
        ? "dark"
        : req.query.theme === "light"
          ? "light"
          : "light dark";
    return res.type("html").send(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        :root{color-scheme:${colorScheme};background:light-dark(#faf8f2,#22211f);color:light-dark(#39352e,#e8e5df)}
        body{font:16px/1.6 system-ui;margin:24px;overflow-wrap:anywhere}
        a{color:light-dark(#67583f,#b5a181)}
        pre{overflow:auto;padding:12px;background:light-dark(#f1ece3,#282623)}
        code{background:light-dark(#f1ece3,#282623)}
        blockquote{margin-left:0;padding-left:16px;border-left:3px solid light-dark(#d1cabd,#45423e)}
        hr,th,td{border-color:light-dark(#d1cabd,#45423e)}
        img{max-width:100%}
      </style></head><body>${renderToStaticMarkup(createElement(MarkdownContent, { markdown: readFileSync(file, "utf8") }))}</body></html>`,
    );
  });
  return app;
}
