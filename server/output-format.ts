import { z } from "zod";
import type { GridInput } from "./domain.js";
import { safePath } from "./files.js";
export const websiteSchema = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })),
});
export function parseOutput(
  format: GridInput["format"],
  raw: string,
): Record<string, string> {
  if (format === "markdown") return { "index.md": raw };
  if (format === "svg") return { "index.svg": raw };
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
