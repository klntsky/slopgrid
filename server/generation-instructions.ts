import type { GridInput } from "./domain.js";

export function instruction(format: GridInput["format"]) {
  return {
    svg: "Fulfill user's SVG generation request. Your response will be saved directly as an image/svg+xml file. Start immediately with <svg and end immediately with </svg>. Include no introduction, explanation, Markdown fences, or other text outside the SVG element.",
    markdown: "Return Markdown.",
    html: `Return only a JSON object {"files":[{"path":"index.html","content":"..."},{"path":"style.css","content":"..."}]} containing a complete static website. Use relative URLs for assets. Files are served statically without server-side execution. Write index.html first with visible page content and basic inline styling, then additional files. Include index.html.`,
    image: "Generate an image.",
  }[format];
}
