import type { WebsitePreviews } from "./website-previews.js";
import type { RequestHandler } from "express";
import type { Store } from "./store.js";
import type { RateLimiter } from "./rate-limit.js";
import type { createHtmlHosts } from "./hosts.js";

export function createHostDispatcher(
  store: Store,
  origin: URL,
  htmlHosts: ReturnType<typeof createHtmlHosts>,
  rate: RateLimiter,
  previews: WebsitePreviews,
): RequestHandler {
  const secure = origin.protocol === "https:";
  return (req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    const host = req.get("host")?.toLowerCase();
    if (host === origin.host) {
      res.set(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'${process.env.NODE_ENV !== "production" ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' ${htmlHosts.frameSource}; connect-src 'self'${process.env.NODE_ENV !== "production" ? " ws:" : ""}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
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
    // Sandboxed module scripts have an opaque origin. These credential-free
    // static assets can be fetched with CORS without opening any API endpoint.
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    res.set("Cache-Control", "no-store");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.method !== "GET" && req.method !== "HEAD")
      return res.sendStatus(405);
    let path: string;
    try {
      path = decodeURIComponent(req.path).slice(1) || "index.html";
    } catch {
      return res.sendStatus(404);
    }
    const output = store.output(id);
    const file = path.startsWith("__preview/")
      ? previews.path(id, path)
      : output?.format === "html"
        ? store.files.path(id, path)
        : previews.path(id, path);
    if (!file) return res.sendStatus(404);
    const mime: Record<string, string> = {
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      json: "application/json",
      svg: "image/svg+xml",
      md: "text/plain",
      txt: "text/plain",
    };
    // OutputFiles confines this path to generated files, including hidden storage roots.
    return res
      .type(mime[path.split(".").pop()!] ?? "text/plain")
      .sendFile(file, { dotfiles: "allow" });
  };
}
