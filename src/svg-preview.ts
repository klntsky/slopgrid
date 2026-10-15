// Recovery belongs only to the disposable preview; persisted source stays verbatim.
export function completeSvgPreview(source: string): string | undefined {
  const start = source.search(/<svg(?:\s|>)/i);
  if (start < 0) return undefined;
  let text = source.slice(start).replace(/\s*```\s*$/, "");
  const stack: string[] = [];
  let result = "",
    offset = 0;
  while (offset < text.length) {
    if (text[offset] !== "<") {
      const end = text.indexOf("<", offset);
      const to = end < 0 ? text.length : end;
      result += text.slice(offset, to).replace(/&[\w#]*$/, "");
      offset = to;
      continue;
    }
    if (
      text.startsWith("<!--", offset) ||
      text.startsWith("<![CDATA[", offset)
    ) {
      const endToken = text.startsWith("<!--", offset) ? "-->" : "]]>";
      const end = text.indexOf(endToken, offset);
      if (end < 0) break;
      result += text.slice(offset, end + endToken.length);
      offset = end + endToken.length;
      continue;
    }
    let end = offset + 1,
      quote = "";
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    let tag = text.slice(offset, Math.min(end + 1, text.length));
    if (end === text.length) {
      if (quote) tag += quote;
      tag = tag.replace(/\s+[\w:-]+\s*=\s*$/, "");
      tag += ">";
    }
    const match = tag.match(/^<(\/?)([\w:-]+)/);
    if (!match) break;
    if (match[1]) {
      if (stack.at(-1) === match[2]) stack.pop();
    } else if (!/\/\s*>$/.test(tag)) stack.push(match[2]);
    if (match[2] === "svg" && !match[1] && !/\sxmlns=/.test(tag))
      tag = tag.replace(/>$/, ' xmlns="http://www.w3.org/2000/svg">');
    result += tag;
    offset = end + 1;
    if (!stack.length) break;
  }
  return (
    result +
    stack
      .reverse()
      .map((name) => `</${name}>`)
      .join("")
  );
}
