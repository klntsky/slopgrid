import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

// Opaque sandbox origins need explicit credentials for stylesheets and module
// graphs to send the output cookie. Rewrite the response, leaving stored files intact.
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
