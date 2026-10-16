const xmlName = /^[A-Za-z_][\w.:-]*/;

/** Prepare accumulated stream text without parsing or reserializing XML. */
export function prepareSvg(source: string): string {
  source = unwrapSvg(source);
  source = completePartialSvg(source) ?? source;
  return source.replace(
    /^(\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*)<svg(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/,
    (root, prefix: string, attributes: string) => {
      // Ignore namespace-like text inside quoted attribute values.
      const names = attributes.replace(/"[^"]*"|'[^']*'/g, "");
      return /(?:^|\s)xmlns\s*=/.test(names)
        ? root
        : `${prefix}<svg xmlns="http://www.w3.org/2000/svg"${attributes}>`;
    },
  );
}

function unwrapSvg(raw: string): string {
  const opening = raw.match(/^\s*(`{3,}|~{3,})[^\r\n`~]*\r?\n/);
  if (!opening) return raw;
  const content = raw.slice(opening[0].length);
  for (const closing of content.matchAll(
    /\r?\n[ \t]*(`+|~+)[ \t]*(?=\r?\n|$)/g,
  )) {
    const remaining = content.slice(closing.index + closing[0].length).trim();
    const sameMarker = closing[1][0] === opening[1][0];
    // Shorter or different markers inside the body belong to its content.
    if (remaining && (!sameMarker || closing[1].length < opening[1].length))
      continue;
    // A closing fence can itself be incomplete, but cannot contain more blocks.
    if (!sameMarker || remaining) return raw;
    return content.slice(0, closing.index);
  }
  return content;
}

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
    if (!attribute) {
      if (!/^\s*(?:[A-Za-z_][\w.:-]*(?:\s*=\s*)?)?$/.test(rest))
        return undefined;
      break;
    }
    const start = cursor + attribute[0].length;
    const end = raw.indexOf(attribute[2], start);
    if (end < 0 && attribute[1].startsWith("xmlns")) break;
    const value = raw.slice(start, end < 0 ? undefined : end);
    if (value.includes("<")) return undefined;
    result +=
      attribute[0] +
      (end < 0 ? withoutPartialEntity(value) : value) +
      attribute[2];
    if (end < 0) break;
    cursor = end + 1;
  }
  return result + (selfClosing ? "/>" : ">");
}

/** Complete unfinished text without rewriting already complete tags. */
function completePartialSvg(draft: string): string | undefined {
  const root = draft.match(
    /^(\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*)<svg(?=[\s/>]|$)/,
  );
  if (!root) return undefined;
  const prefix = root[1];
  const source = draft.slice(prefix.length),
    parts: string[] = [],
    stack: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const next = source.indexOf("<", cursor);
      const end = next < 0 ? source.length : next;
      const text = source.slice(cursor, end);
      parts.push(next < 0 ? withoutPartialEntity(text) : text);
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
      if (end < 0) {
        if (special[0] === "]]>") parts.push(tail + "]]>");
        break;
      }
      parts.push(source.slice(cursor, end + special[0].length));
      cursor = end + special[0].length;
      continue;
    }
    if (tail.startsWith("<!")) {
      if (["<!--", "<![CDATA["].some((opening) => opening.startsWith(tail)))
        break;
      return undefined;
    }
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
      if (tail.startsWith("</")) {
        if (!stack.at(-1)?.startsWith(tail.slice(2).trimEnd()))
          return undefined;
        break;
      }
      tag = finishOpeningTag(tail);
    } else tag = source.slice(cursor, end + 1);
    if (!tag) {
      if (tail === "<") break;
      return undefined;
    }
    const closing = tag.match(/^<\/([A-Za-z_][\w.:-]*)\s*>$/);
    if (closing) {
      if (stack.pop() !== closing[1]) return undefined;
      parts.push(tag);
      if (!stack.length) {
        const tail = source.slice(end + 1);
        return tail.trim() ? undefined : prefix + parts.join("") + tail;
      }
    } else {
      const name = tag.slice(1).match(xmlName)?.[0];
      if (!name) return undefined;
      parts.push(tag);
      if (!/\/\s*>$/.test(tag)) stack.push(name);
      else if (!stack.length) {
        const tail = source.slice(end + 1);
        return tail.trim() ? undefined : prefix + parts.join("") + tail;
      }
    }
    cursor = end + 1;
  }
  return parts.length
    ? prefix +
        parts.join("") +
        stack
          .reverse()
          .map((name) => `</${name}>`)
          .join("")
    : undefined;
}
