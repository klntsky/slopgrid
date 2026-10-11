import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = memo(function MarkdownContent({
  markdown,
}: {
  markdown: string;
}) {
  return <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>;
});
