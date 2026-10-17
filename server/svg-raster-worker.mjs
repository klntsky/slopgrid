import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

export const svgRasterWorkerURL = new URL(import.meta.url);
// Official DejaVu 2.37 archive SHA256:
// fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7
// https://dejavu-fonts.github.io/Download.html; license: public/fonts/DejaVu-LICENSE.txt.
const fontSha256 = "b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582";

async function render(svg) {
  const require = createRequire(import.meta.url);
  const [wasm, font] = await Promise.all([
    readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")),
    readFile(new URL("./assets/DejaVuSansMono.ttf", import.meta.url)),
  ]);
  if (createHash("sha256").update(font).digest("hex") !== fontSha256)
    throw new Error("Bundled SVG font checksum mismatch");
  await initWasm(wasm);
  const family = "DejaVu Sans Mono";
  const options = {
    dpi: 96,
    font: {
      fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: family,
      serifFamily: family, sansSerifFamily: family, cursiveFamily: family,
      fantasyFamily: family, monospaceFamily: family,
    },
  };
  let renderer = new Resvg(svg, options);
  let image;
  try {
    if (renderer.imagesToResolve().length)
      throw new Error("Unresolved SVG image resources");
    // The API exposes intrinsic dimensions after parsing; fitTo is construction-only.
    if (Math.max(renderer.width, renderer.height) > 2048) {
      const mode = renderer.width >= renderer.height ? "width" : "height";
      renderer.free();
      renderer = undefined;
      renderer = new Resvg(svg, { ...options, fitTo: { mode, value: 2048 } });
    }
    image = renderer.render();
    return image.asPng();
  } finally {
    image?.free();
    renderer?.free();
  }
}

if (!isMainThread) {
  try {
    const png = await render(workerData);
    parentPort.postMessage(png, [png.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}
