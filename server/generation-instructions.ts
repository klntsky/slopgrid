import type { GridInput } from "./domain.js";

export function instruction(format: GridInput["format"]) {
  return {
    svg: 'Fulfill user\'s SVG generation request. Your response will be saved directly as an image/svg+xml file. Start immediately with <svg and end immediately with </svg>. The root <svg> element must include xmlns="http://www.w3.org/2000/svg". Include no introduction, explanation, Markdown fences, or other text outside the SVG element. Do not include JavaScript, script elements, event handler attributes, or javascript: URLs. Use only declarative SVG or CSS for animation. IMPORTANT CAVEAT: All CSS must obey XML escaping rules, including comments. In particular, DO NOT use the symbol & unescaped in CSS comments',
    markdown: "Return Markdown.",
    chat: "",
    html: `Return only a JSON object {"files":[{"path":"index.html","content":"..."},{"path":"style.css","content":"..."}]} containing a complete static website. Use relative URLs for assets. Files are served statically without server-side execution. Write index.html first with visible page content and basic inline styling, then additional files. Include index.html.`,
    image: "Generate an image.",
  }[format];
}
