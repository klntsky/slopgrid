const xmlName = /^[A-Za-z_][\w.:-]*/;

function withoutPartialEntity(text: string): string {
  return text.replace(/&(?:#(?:x[\da-fA-F]*|\d*)?|[A-Za-z][\w.-]*)?$/, "");
}

// Keep completed attributes and finish a quoted value that is still streaming.
// A partial attribute name or equals sign has no usable value yet, so omit it.
function finishOpeningTag(raw: string): string | undefined {
  const name = raw.slice(1).match(xmlName)?.[0];
  if (!name) return undefined;
  let result = `<${name}`,
    cursor = name.length + 1,
    selfClosing = false;
  while (cursor < raw.length) {
    const rest = raw.slice(cursor);
    if (rest.trim() === "/") {
      selfClosing = true;
      break;
    }
    const attribute = rest.match(/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])/);
    if (!attribute) break;
    const start = cursor + attribute[0].length;
    const end = raw.indexOf(attribute[2], start);
    if (end < 0 && attribute[1].startsWith("xmlns")) break;
    const value = raw.slice(start, end < 0 ? undefined : end);
    if (value.includes("<")) break;
    result +=
      attribute[0] +
      (end < 0 ? withoutPartialEntity(value) : value) +
      attribute[2];
    if (end < 0) break;
    cursor = end + 1;
  }
  return result + (selfClosing ? "/>" : ">");
}

/** Complete a disposable SVG image preview; never modify the generated output. */
export function completeSvgPreview(draft: string): string | undefined {
  const start = draft.search(/<svg(?=[\s/>]|$)/);
  if (start < 0) return undefined;
  const source = draft.slice(start),
    parts: string[] = [],
    stack: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const next = source.indexOf("<", cursor);
      const end = next < 0 ? source.length : next;
      parts.push(withoutPartialEntity(source.slice(cursor, end)));
      cursor = end;
      continue;
    }
    const tail = source.slice(cursor);
    const special = tail.startsWith("<!--")
      ? (["-->", 4] as const)
      : tail.startsWith("<![CDATA[")
        ? (["]]>", 9] as const)
        : tail.startsWith("<?")
          ? (["?>", 2] as const)
          : undefined;
    if (special) {
      const end = source.indexOf(special[0], cursor + special[1]);
      if (end < 0) break;
      parts.push(source.slice(cursor, end + special[0].length));
      cursor = end + special[0].length;
      continue;
    }
    if (tail.startsWith("<!")) break;
    let end = cursor + 1,
      quote = "";
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    let tag: string | undefined;
    if (end === source.length) {
      if (tail.startsWith("</")) break;
      tag = finishOpeningTag(tail);
    } else tag = source.slice(cursor, end + 1);
    if (!tag) break;
    const closing = tag.match(/^<\/([A-Za-z_][\w.:-]*)\s*>$/);
    if (closing) {
      if (stack.pop() !== closing[1]) return undefined;
      parts.push(tag);
      if (!stack.length) return parts.join("");
    } else {
      const name = tag.slice(1).match(xmlName)?.[0];
      if (!name) return undefined;
      if (!parts.length && name === "svg" && !/\sxmlns\s*=/.test(tag))
        tag = tag.replace(
          /\/?>$/,
          (ending) => ` xmlns="http://www.w3.org/2000/svg"${ending}`,
        );
      parts.push(tag);
      if (!/\/\s*>$/.test(tag)) stack.push(name);
      else if (!stack.length) return parts.join("");
    }
    cursor = end + 1;
  }
  return parts.length
    ? parts.join("") +
        stack
          .reverse()
          .map((name) => `</${name}>`)
          .join("")
    : undefined;
}
