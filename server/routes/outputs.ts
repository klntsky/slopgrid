import { Router } from "express";
import { readFileSync } from "node:fs";
import { marked, Renderer } from "marked";
import type { Store } from "../store.js";
import type { RateLimiter } from "../rate-limit.js";
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function createOutputRoutes(
  store: Store,
  origin: URL,
  rate: RateLimiter,
) {
  const app = Router();
  const markdownRenderer = new Renderer();
  markdownRenderer.html = ({ text }) => escape(text);
  app.get("/outputs/:id", (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{48}$/.test(id)) return res.sendStatus(404);
    if (!rate(`output:${req.ip}`, 2000, 60000)) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many requests. Try again in a minute.");
    }
    const output = store.output(id);
    if (!output || output.format === "html") return res.sendStatus(404);
    res.set("Cache-Control", "no-store");
    res.set(
      "Content-Security-Policy",
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin.origin}`,
    );
    const filename =
      output.format === "image"
        ? "image"
        : output.format === "svg"
          ? "index.svg"
          : "index.md";
    const file = store.files.path(id, filename);
    if (!file) return res.sendStatus(404);
    if (output.format === "image")
      return res
        .type(output.mediaType ?? "application/octet-stream")
        .sendFile(file, { dotfiles: "allow" });
    if (output.format === "svg")
      return res.type("image/svg+xml").sendFile(file, { dotfiles: "allow" });
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
      </style></head><body>${marked.parse(readFileSync(file, "utf8"), { renderer: markdownRenderer })}</body></html>`,
    );
  });
  return app;
}
