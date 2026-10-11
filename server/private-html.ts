import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

// Sandboxed documents have an opaque origin. Module graphs must explicitly
// include the host-only output cookie, including their relative imports.
export function privateHtml(source: string) {
  const document = parse(source);
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if (
      "attrs" in node &&
      (node.tagName === "script" ||
        node.tagName === "link" ||
        node.attrs.some((attr) => attr.name === "crossorigin"))
    ) {
      node.attrs = node.attrs.filter((attr) => attr.name !== "crossorigin");
      node.attrs.push({ name: "crossorigin", value: "use-credentials" });
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  }
  visit(document);
  return serialize(document);
}
