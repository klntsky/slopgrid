import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = memo(function MarkdownContent({
  markdown,
  components,
}: {
  markdown: string;
  components?: Components;
}) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {markdown}
    </Markdown>
  );
});
