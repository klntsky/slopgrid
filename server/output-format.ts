import { z } from "zod";
import type { GridInput } from "./domain.js";
import { safePath } from "./files.js";
const extensions = new Set(["html", "css", "js", "json", "txt", "svg", "md"]);
export function parseOutput(
  format: GridInput["format"],
  raw: string,
): Record<string, string> {
  const clean = raw
    .trim()
    .replace(/^```(?:\w+)?\s*\n/, "")
    .replace(/\n```$/, "");
  if (format === "markdown") return { "index.md": clean };
  if (format === "svg") return { "index.svg": clean };
  if (format === "html") {
    const parsed = z
      .object({
        files: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(clean));
    if (!Object.hasOwn(parsed.files, "index.html"))
      throw new Error("The bundle needs index.html");
    for (const path of Object.keys(parsed.files))
      if (!safePath(path) || !extensions.has(path.split(".").pop()!))
        throw new Error("Use safe relative static file paths");
    return parsed.files;
  }
  throw new Error("Images are returned as image data");
}
export function instruction(format: GridInput["format"]) {
  return {
    svg: "Fulfill user's SVG generation request. Your response will be saved directly as an image/svg+xml file. Start immediately with <svg and end immediately with </svg>. Include no introduction, explanation, Markdown fences, or other text outside the SVG element.",
    markdown: "Return Markdown.",
    html: 'Return only a JSON object {"files":{"index.html":"...","style.css":"..."}} containing a complete static website. Use relative URLs for assets. Only html, css, js, json, txt, svg, md files; no server-side code. Write index.html first with visible page content and basic inline styling, then additional files. Include index.html.',
    image: "Generate an image.",
  }[format];
}
