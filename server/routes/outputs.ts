import { Router } from "express";
import { isMarkdownFormat } from "../domain.js";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../../shared/markdown.js";
import { ChatConversation } from "../../shared/chat-conversation.js";
import { readChatOutput } from "../../shared/chat-output.js";
import type { FilledChatMessage } from "../domain.js";
import type { Store } from "../store.js";
import type { RateLimiter } from "../rate-limit.js";
import { zip } from "fflate";
import { downloadFilename } from "../download-filename.js";
import { canViewGrid } from "../grid-policy.js";
import type { SessionReader } from "../session.js";
import { offlineWebsite, offlineWebsitePolicy } from "../offline-website.js";

const markdownFont = readFileSync(
  new URL("../../public/fonts/DejaVuSansMono.woff2", import.meta.url),
).toString("base64");
const conversationStyle = readFileSync(
  new URL("../../shared/chat-conversation.css", import.meta.url),
  "utf8",
);

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
      "chat-template": {
        filename: "messages.json",
        mediaType: "application/json",
        extension: "json",
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
  app.use(["/outputs/:id", "/offline/outputs/:id"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params.id);
    const output = /^[a-f0-9]{48}$/.test(id)
      ? store.outputMetadata(id)
      : undefined;
    const viewer = session.read(req);
    if (!output || !canViewGrid(output, viewer)) return res.sendStatus(404);
    res.locals.output = output;
    if (output.outputReady) res.set("X-Slopgrid-Output-Ready", "1");
    res.locals.file = outputFile(output);
    next();
  });
  app.get("/outputs/:id/offline", async (req, res) => {
    const output = res.locals.output;
    if (!output.outputReady || output.format !== "html")
      return res.sendStatus(404);
    const id = String(req.params.id);
    const pages = await offlineWebsite(
      await store.files.bundle(id),
      id,
      origin.origin,
    );
    res.json({ pages });
  });
  app.get("/offline/outputs/:id/*path", async (req, res) => {
    res.set("Content-Security-Policy", offlineWebsitePolicy);
    const output = res.locals.output;
    if (!output.outputReady || output.format !== "html")
      return res.sendStatus(404);
    const id = String(req.params.id);
    const path = (req.params.path as string[]).join("/");
    const pages = await offlineWebsite(
      await store.files.bundle(id),
      id,
      origin.origin,
    );
    if (!Object.hasOwn(pages, path)) return res.sendStatus(404);
    res.type("html").send(pages[path]);
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
    const file =
      store.files.path(id, filename) ??
      (output.format === "chat-template"
        ? store.files.path(id, "index.md")
        : undefined);
    if (!file) return res.sendStatus(404);
    if (output.format === "chat-template")
      return res
        .type(mediaType)
        .send(
          JSON.stringify(readChatOutput(readFileSync(file, "utf8")), null, 2),
        );
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
    if (!output.outputReady || output.format === "html")
      return res.sendStatus(404);
    res.set(
      "Content-Security-Policy",
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin.origin}`,
    );
    const { filename, mediaType } = res.locals.file as ReturnType<
      typeof outputFile
    >;
    const file =
      store.files.path(id, filename) ??
      (output.format === "chat-template"
        ? store.files.path(id, "index.md")
        : undefined);
    if (!file) return res.sendStatus(404);
    if (output.format === "svg" || output.format === "image") {
      if (output.published) {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res
          .vary("Cookie")
          .set(
            "Cache-Control",
            "private, max-age=31536000, immutable, must-revalidate",
          );
      }
    }
    const messages: FilledChatMessage[] | undefined =
      output.format === "chat-template"
        ? readChatOutput(readFileSync(file, "utf8"))
        : undefined;
    if (messages && req.query.raw === "1")
      return res
        .type("application/json")
        .send(JSON.stringify(messages, null, 2));
    if (!isMarkdownFormat(output.format) || req.query.raw === "1")
      return res
        .type(isMarkdownFormat(output.format) ? "text/plain" : mediaType)
        .sendFile(file, { dotfiles: "allow" });
    const colorScheme =
      req.query.theme === "dark"
        ? "dark"
        : req.query.theme === "light"
          ? "light"
          : "light dark";
    // Embed the font so sandboxed Markdown needs no external font access.
    res.set(
      "Content-Security-Policy",
      `${res.get("Content-Security-Policy")}; font-src data:`,
    );
    return res.type("html").send(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        @font-face{font-family:"Slopgrid Mono";src:url(data:font/woff2;base64,${markdownFont}) format("woff2");font-display:block}
        :root{color-scheme:${colorScheme};background:light-dark(#faf8f2,#22211f);color:light-dark(#39352e,#e8e5df)}
        body{font:16px/1.6 system-ui;margin:24px;overflow-wrap:anywhere}
        a{color:light-dark(#67583f,#b5a181)}
        pre{overflow:auto;padding:12px;background:light-dark(#f1ece3,#282623);line-height:normal}
        pre,pre>code{font-family:"Slopgrid Mono",monospace}
        code{background:light-dark(#f1ece3,#282623)}
        blockquote{margin-left:0;padding-left:16px;border-left:3px solid light-dark(#d1cabd,#45423e)}
        hr,th,td{border-color:light-dark(#d1cabd,#45423e)}
        img{max-width:100%}
        ${messages ? conversationStyle : ""}
      </style></head><body>${renderToStaticMarkup(messages ? createElement(ChatConversation, { messages }) : createElement(MarkdownContent, { markdown: readFileSync(file, "utf8") }))}</body></html>`,
    );
  });
  return app;
}
