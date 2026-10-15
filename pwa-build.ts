import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { offlineWebsitePolicy } from "./server/offline-website";

export function pwaBuild(): Plugin {
  let directory: string;
  return {
    name: "slopgrid-pwa",
    apply: "build",
    configResolved(config) {
      directory = resolve(config.root, config.build.outDir);
    },
    writeBundle(_, bundle) {
      const shell = readFileSync(resolve(directory, "index.html"), "utf8");
      writeFileSync(resolve(directory, "offline-shell.html"), shell);
      const assets = [
        ...Object.keys(bundle).filter((path) => path.startsWith("assets/")),
        ...readdirSync("public", { recursive: true })
          .map(String)
          .filter((path) => /\.(svg|png|woff2|webmanifest)$/.test(path)),
        "theme.js",
        "offline-shell.html",
      ].map((path) => "/" + path);
      const worker = readFileSync("public/sw.js", "utf8");
      const version = createHash("sha256").update(worker);
      for (const asset of assets)
        version.update(readFileSync(resolve(directory, "." + asset)));
      writeFileSync(
        resolve(directory, "sw.js"),
        worker
          .replace("__PWA_ASSETS__", JSON.stringify(assets))
          .replace(
            "__PWA_VERSION__",
            JSON.stringify(version.digest("hex").slice(0, 16)),
          )
          .replace("__PWA_POLICY__", JSON.stringify(offlineWebsitePolicy)),
      );
    },
  };
}
