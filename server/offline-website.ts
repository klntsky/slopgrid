import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap as Tree,
} from "parse5";
import { init, parse as parseModule } from "es-module-lexer";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { websiteHtml } from "./website-html.js";

// Offline documents have no network capabilities. The response header, rather
// than a removable meta element, enforces the opaque sandbox and resource policy.
export const offlineWebsitePolicy =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export async function offlineWebsite(
  files: Record<string, Uint8Array>,
  id: string,
  appOrigin: string,
) {
  await init;
  const base = `https://offline.invalid/${id}/`;
  const text = (path: string) => Buffer.from(files[path]).toString("utf8");
  const data = (mime: string, bytes: string | Uint8Array) =>
    `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  function pathFor(value: string, from: string) {
    try {
      const url = new URL(value, base + from);
      if (url.origin !== "https://offline.invalid") return;
      const path = decodeURIComponent(
        url.pathname.startsWith(`/${id}/`)
          ? url.pathname.slice(id.length + 2)
          : url.pathname.slice(1),
      );
      if (Object.hasOwn(files, path)) return { path, hash: url.hash };
    } catch {
      /* Invalid resource references stay unavailable. */
    }
  }
  const mime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    ico: "image/x-icon",
  };
  function resource(value: string, from: string) {
    if (value.startsWith("data:") || value.startsWith("#")) return value;
    const target = pathFor(value, from);
    return target
      ? data(
          mime[target.path.split(".").pop()!] ?? "application/octet-stream",
          files[target.path],
        ) + target.hash
      : "data:,";
  }
  function cssValue(value: string, from: string) {
    const parsed = valueParser(value);
    parsed.walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "url") {
        const value = valueParser
          .stringify(node.nodes)
          .replace(/^(['"])(.*)\1$/, "$2");
        node.nodes = [
          {
            type: "string",
            quote: '"',
            value: resource(value, from),
            sourceIndex: 0,
            sourceEndIndex: 0,
          },
        ];
        return false;
      }
    });
    return parsed.toString();
  }
  function css(source: string, from: string, ancestors: string[] = []): string {
    try {
      const root = postcss.parse(source);
      root.walkAtRules("import", (rule) => {
        const parsed = valueParser(rule.params);
        const first = parsed.nodes[0];
        const reference =
          first?.type === "string"
            ? first.value
            : first?.type === "function"
              ? valueParser
                  .stringify(first.nodes)
                  .replace(/^(['"])(.*)\1$/, "$2")
              : "";
        const target = pathFor(reference, from);
        if (!target || ancestors.includes(target.path)) {
          rule.remove();
          return;
        }
        const replacement = data(
          "text/css",
          css(text(target.path), target.path, [...ancestors, from]),
        );
        rule.params = `url("${replacement}")${valueParser.stringify(parsed.nodes.slice(1))}`;
      });
      root.walkDecls((decl) => {
        decl.value = cssValue(decl.value, from);
      });
      return root.toString();
    } catch {
      return source;
    }
  }
  const modules: Record<string, string> = {};
  function moduleSource(source: string, from: string) {
    try {
      const [imports] = parseModule(source);
      for (const entry of [...imports].reverse()) {
        if (entry.type === "import-meta") continue;
        const target = entry.specifier
          ? pathFor(entry.specifier, from)
          : undefined;
        if (target) {
          prepareModule(target.path);
          const reference = base + target.path;
          source =
            source.slice(0, entry.start) +
            (entry.type === "dynamic" ? JSON.stringify(reference) : reference) +
            source.slice(entry.end);
        }
      }
    } catch {
      /* Preserve classic scripts and invalid generated JavaScript. */
    }
    return source;
  }
  function prepareModule(path: string) {
    if (Object.hasOwn(modules, base + path)) return;
    modules[base + path] = ""; // Reserve before following cyclic imports.
    modules[base + path] = data(
      "text/javascript",
      moduleSource(text(path), path),
    );
  }
  for (const path of Object.keys(files))
    if (/\.(?:m?js)$/.test(path)) prepareModule(path);
  const pages: Record<string, string> = {};
  for (const path of Object.keys(files).filter((path) =>
    path.endsWith(".html"),
  )) {
    const document = parse(websiteHtml(text(path), appOrigin));
    let head: Tree["element"] | undefined;
    function visit(node: Tree["node"]) {
      if ("tagName" in node) {
        if (node.tagName === "head") head = node;
        const attr = (name: string) =>
          node.attrs.find((attr) => attr.name === name);
        const source = attr("src");
        const href = attr("href");
        if (node.tagName === "script") {
          const isModule = attr("type")?.value === "module";
          if (source) {
            const target = pathFor(source.value, path);
            if (target) {
              if (isModule) prepareModule(target.path);
              source.value = isModule
                ? modules[base + target.path]
                : data("text/javascript", text(target.path));
            } else source.value = "data:,";
          } else if (isModule) {
            for (const child of node.childNodes)
              if (child.nodeName === "#text")
                (child as Tree["textNode"]).value = moduleSource(
                  (child as Tree["textNode"]).value,
                  path,
                );
          }
        } else if (
          node.tagName === "link" &&
          href &&
          attr("rel")?.value === "stylesheet"
        ) {
          const target = pathFor(href.value, path);
          href.value = target
            ? data("text/css", css(text(target.path), target.path))
            : "data:,";
        } else if (
          node.tagName === "a" &&
          href &&
          !href.value.startsWith("#")
        ) {
          const target = pathFor(href.value, path);
          href.value =
            target && target.path.endsWith(".html")
              ? `/offline/outputs/${id}/${target.path}${target.hash}`
              : "#";
        } else {
          for (const name of ["src", "href", "poster", "xlink:href"]) {
            const attribute = attr(name);
            if (attribute) attribute.value = resource(attribute.value, path);
          }
        }
        const srcset = attr("srcset");
        if (srcset && !srcset.value.includes("data:"))
          srcset.value = srcset.value
            .split(",")
            .map((item) => {
              const [url, ...size] = item.trim().split(/\s+/);
              return [resource(url, path), ...size].join(" ");
            })
            .join(", ");
        const style = attr("style");
        if (style) style.value = cssValue(style.value, path);
        if (node.tagName === "style")
          for (const child of node.childNodes)
            if (child.nodeName === "#text")
              (child as Tree["textNode"]).value = css(
                (child as Tree["textNode"]).value,
                path,
              );
        node.attrs = node.attrs.filter(
          (attr) => attr.name !== "integrity" && attr.name !== "crossorigin",
        );
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
      if ("content" in node) visit(node.content);
    }
    visit(document);
    if (head) {
      const bridge = parseFragment(
        `<script type="importmap">${JSON.stringify({ imports: modules }).replaceAll("<", "\\u003c")}</script><script>addEventListener("click",event=>{const link=event.target.closest?.("a[href]");if(parent!==window&&link?.getAttribute("href")?.startsWith(${JSON.stringify(`/offline/outputs/${id}/`)})){event.preventDefault();parent.postMessage({type:"slopgrid:offline-navigation",path:link.getAttribute("href")},${JSON.stringify(appOrigin)})}})</script>`,
      ).childNodes;
      for (const node of bridge) node.parentNode = head;
      head.childNodes.unshift(...bridge);
    }
    pages[path] = serialize(document);
  }
  return pages;
}
