import type { GenerationAPI } from "./generation-api.js";
import type { RequestHandler } from "express";
import type { Store } from "./store.js";
import type { RateLimiter } from "./rate-limit.js";
import type { createHtmlHosts } from "./hosts.js";
import type { OutputAccess } from "./output-access.js";
import { readFileSync } from "node:fs";
import { websiteHtml } from "./website-html.js";

export function createHostDispatcher(
  store: Store,
  origin: URL,
  htmlHosts: ReturnType<typeof createHtmlHosts>,
  rate: RateLimiter,
  generation: GenerationAPI,
  access: OutputAccess,
): RequestHandler {
  const secure = origin.protocol === "https:";
  return async (req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    const host = req.get("host")?.toLowerCase();
    if (host === origin.host) {
      res.set(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'${process.env.NODE_ENV !== "production" ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' ${htmlHosts.frameSource}; connect-src 'self'${process.env.NODE_ENV !== "production" ? " ws:" : ""}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
      );
      if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
      return next();
    }
    const id = host ? htmlHosts.cellId(host) : undefined;
    if (!id) return res.status(421).send("Unknown host");
    const previewRequest = req.path.startsWith("/__preview/");
    if (
      !rate(
        `${previewRequest ? "preview" : "output"}:${req.ip}`,
        previewRequest ? 20000 : 2000,
        60000,
      )
    ) {
      res.set("Retry-After", "60");
      return res.status(429).send("Too many requests. Try again in a minute.");
    }
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD")
      return res.sendStatus(405);
    if (req.path.startsWith("/__session/")) return access.redeem(req, res, id);
    const output = access.read(req, id);
    if (!output) {
      // A direct HTML navigation can establish access through the app's live session.
      // Asset requests cannot use this redirect to obtain authorization.
      if (
        req.get("sec-fetch-dest") === "document" &&
        (req.path === "/" || req.path.endsWith(".html"))
      )
        return res.redirect(
          `${origin.origin}/outputs/${id}/website?path=${encodeURIComponent(req.path.slice(1) || "index.html")}`,
        );
      return res.sendStatus(404);
    }
    if (output.published) res.set("Access-Control-Allow-Origin", "*");
    let path: string;
    try {
      path = decodeURIComponent(req.path).slice(1) || "index.html";
    } catch {
      return res.sendStatus(404);
    }
    const file = path.startsWith("__preview/")
      ? await generation.previewPath({ cellId: id, path })
      : output.outputReady && output.format === "html"
        ? store.files.path(output.artifactId!, path)
        : await generation.previewPath({ cellId: id, path });
    if (!file) return res.sendStatus(404);
    if (path.endsWith(".html")) {
      const html = websiteHtml(readFileSync(file, "utf8"), origin.origin);
      return res.type("html").send(html);
    }
    // OutputFiles confines this path to generated files, including hidden storage roots.
    return res.sendFile(file, { dotfiles: "allow" });
  };
}
