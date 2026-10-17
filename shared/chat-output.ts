import type { FilledChatMessage } from "../server/domain.js";

// Older artifacts have only the Markdown transcript. New artifacts retain the
// messages themselves so headings in a body never determine message boundaries.
export function readChatOutput(markdown: string): FilledChatMessage[] {
  if (!markdown) return [];
  if (markdown.startsWith("[")) return JSON.parse(markdown);
  const headings: {
    role: FilledChatMessage["role"];
    start: number;
    body: number;
  }[] = [];
  let offset = 0;
  let fence = "";
  for (const line of markdown.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = "";
    } else if (marker) {
      fence = marker[1];
    } else {
      const heading = /^## (system|user|assistant)$/.exec(line);
      if (
        heading &&
        (offset === 0 || markdown.slice(offset - 2, offset) === "\n\n") &&
        markdown[offset + line.length + 1] === "\n"
      ) {
        headings.push({
          role: heading[1] as FilledChatMessage["role"],
          start: offset,
          body: offset + line.length + 2,
        });
      }
    }
    offset += line.length + 1;
  }
  if (headings[0]?.start !== 0)
    return [{ role: "assistant", content: markdown }];
  return headings.map((heading, index) => ({
    role: heading.role,
    content: markdown.slice(
      heading.body,
      headings[index + 1] ? headings[index + 1].start - 2 : undefined,
    ),
  }));
}
