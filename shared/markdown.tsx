import { memo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = memo(function MarkdownContent({
  markdown,
}: {
  markdown: string;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url, key) =>
        key === "src"
          ? /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)(?:;|,)/i.test(
              url,
            )
            ? url
            : undefined
          : defaultUrlTransform(url)
      }
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
        img: ({ node: _node, src, alt, ...props }) =>
          src ? (
            <img {...props} src={src} alt={alt ?? ""} />
          ) : (
            <span>{alt}</span>
          ),
        input: ({ node: _node, ...props }) => (
          <input {...props} type="checkbox" disabled />
        ),
      }}
    >
      {markdown}
    </Markdown>
  );
});
