import { z } from "zod";
import type { GridInput } from "./domain.js";
import { safePath } from "./files.js";
export const websiteSchema = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })),
});

function unwrapSvg(raw: string): string {
  const block = raw.match(
    /^\s*(`{3,}|~{3,})[^\r\n`~]*\r?\n([\s\S]*?)\r?\n[ \t]*(`{3,}|~{3,})\s*$/,
  );
  if (!block) return raw;
  const [, opening, content, closing] = block;
  if (closing[0] !== opening[0] || closing.length < opening.length) return raw;
  // An earlier closing fence means this is more than one enclosing block.
  const earlierClose = new RegExp(
    `^[ \\t]*${opening[0]}{${opening.length},}[ \\t]*\\r?$`,
    "m",
  );
  return earlierClose.test(content) ? raw : content;
}

export function parseOutput(
  format: GridInput["format"],
  raw: string,
): Record<string, string> {
  if (format === "markdown") return { "index.md": raw };
  if (format === "svg") return { "index.svg": unwrapSvg(raw) };
  if (format === "html") {
    const entries = websiteSchema
      .parse(JSON.parse(raw))
      .files.map(({ path, content }) => [path, content] as const);
    const files = Object.fromEntries(entries);
    if (entries.length !== Object.keys(files).length)
      throw new Error("The bundle contains duplicate file paths");
    if (!Object.hasOwn(files, "index.html"))
      throw new Error("The bundle needs index.html");
    for (const path of Object.keys(files))
      if (!safePath(path))
        throw new Error("Use safe relative static file paths");
    return files;
  }
  throw new Error("Images are returned as image data");
}
export { instruction } from "./generation-instructions.js";
