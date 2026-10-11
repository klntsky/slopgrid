import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap,
} from "parse5";

// Rewrite served HTML only; downloads and stored generated files remain untouched.
export function websiteHtml(
  source: string,
  privateOutput: boolean,
  appOrigin: string,
) {
  const document = parse(source);
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if (
      // Opaque sandbox origins need explicit credentials to send the output cookie.
      privateOutput &&
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
  const root = document.childNodes.find(
    (node) => "tagName" in node && node.tagName === "html",
  );
  if (root && "childNodes" in root) {
    const head = root.childNodes.find(
      (node) => "tagName" in node && node.tagName === "head",
    );
    if (head && "childNodes" in head) {
      // The port carries only scroll coordinates; it grants no parent DOM or cookie access.
      const bridge = parseFragment(`<script>
        addEventListener("message", event => {
          if (parent === window || event.source !== parent || event.origin !== ${JSON.stringify(appOrigin)} || event.data?.type !== "slopgrid:scroll" || !event.ports[0]) return;
          const port = event.ports[0];
          if (event.data.positions) {
            for (const [selector, left, top] of event.data.positions) {
              const target = selector ? document.querySelector(selector) : window;
              target?.scrollTo({ left, top, behavior: "instant" });
            }
            port.postMessage(null);
          } else {
            const positions = [["", scrollX, scrollY]];
            for (const node of document.querySelectorAll("*")) {
              if (node === document.scrollingElement || (!node.scrollLeft && !node.scrollTop)) continue;
              const path = [];
              for (let element = node; element; element = element.parentElement) {
                if (element.id) { path.unshift("#" + CSS.escape(element.id)); break; }
                const index = element.parentElement ? [...element.parentElement.children].indexOf(element) + 1 : 1;
                path.unshift(element.localName + ":nth-child(" + index + ")");
              }
              positions.push([path.join(">"), node.scrollLeft, node.scrollTop]);
            }
            port.postMessage(positions);
          }
          port.close();
        });
      </script>`).childNodes[0];
      bridge.parentNode = head;
      head.childNodes.unshift(bridge);
    }
  }
  return serialize(document);
}
