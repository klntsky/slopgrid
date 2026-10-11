import { z } from "zod";
import type { GridInput } from "./domain.js";
import { safePath } from "./files.js";
const extensions = new Set(["html", "css", "js", "json", "txt", "svg", "md"]);
export const websiteSchema = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })),
});
export function parseOutput(
  format: GridInput["format"],
  raw: string,
  structured = false,
): Record<string, string> {
  if (format === "markdown") return { "index.md": raw };
  const clean = raw
    .trim()
    .replace(/^```(?:\w+)?\s*\n/, "")
    .replace(/\n```$/, "");
  if (format === "svg") return { "index.svg": clean };
  if (format === "html") {
    const value: unknown = JSON.parse(clean);
    const entries = structured
      ? websiteSchema
          .parse(value)
          .files.map(({ path, content }) => [path, content] as const)
      : Object.entries(
          z.object({ files: z.record(z.string(), z.string()) }).parse(value)
            .files,
        );
    const files = Object.fromEntries(entries);
    if (entries.length !== Object.keys(files).length)
      throw new Error("The bundle contains duplicate file paths");
    if (!Object.hasOwn(files, "index.html"))
      throw new Error("The bundle needs index.html");
    for (const path of Object.keys(files))
      if (!safePath(path) || !extensions.has(path.split(".").pop()!))
        throw new Error("Use safe relative static file paths");
    return files;
  }
  throw new Error("Images are returned as image data");
}
export function instruction(format: GridInput["format"], structured = false) {
  return {
    svg: "Fulfill user's SVG generation request. Your response will be saved directly as an image/svg+xml file. Start immediately with <svg and end immediately with </svg>. Include no introduction, explanation, Markdown fences, or other text outside the SVG element.",
    markdown: "Return Markdown.",
    html: `Return only a JSON object ${structured ? '{"files":[{"path":"index.html","content":"..."},{"path":"style.css","content":"..."}]}' : '{"files":{"index.html":"...","style.css":"..."}}'} containing a complete static website. Use relative URLs for assets. Only html, css, js, json, txt, svg, md files; no server-side code. Write index.html first with visible page content and basic inline styling, then additional files. Include index.html.`,
    image: "Generate an image.",
  }[format];
}
