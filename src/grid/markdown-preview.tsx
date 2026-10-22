import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { ErrorMessage } from "../components/feedback-message";
import { MarkdownContent } from "../../shared/markdown";
import "./markdown-preview.css";
import { textOutput } from "./text-output";
import { ChatConversation } from "../../shared/chat-conversation";
import { readChatOutput } from "../../shared/chat-output";
import "../../shared/chat-conversation.css";

export function MarkdownPreview({
  url,
  title,
  raw = false,
  draft,
  streaming = false,
  conversation = false,
}: {
  url: string;
  title: string;
  raw?: boolean | "thinking";
  draft?: string;
  streaming?: boolean;
  conversation?: boolean;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const lastDraft = useRef(draft);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (streaming) lastDraft.current = draft ?? "";
  }, [draft, streaming]);
  const query = useQuery({
    ...textOutput(url),
    enabled: !streaming,
  });
  const markdown = streaming
    ? (draft ?? "")
    : (query.data ?? lastDraft.current);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const document = documentRef.current;
    if (!preview || !document) return;
    if (raw) {
      document.style.removeProperty("width");
      document.style.removeProperty("zoom");
      if (raw !== "thinking") return;
      const follow = () => {
        if (following.current) {
          preview.scrollTop = preview.scrollHeight;
          lastScrollTop.current = preview.scrollTop;
        }
      };
      follow();
      const observer = new ResizeObserver(follow);
      observer.observe(preview);
      observer.observe(document);
      return () => observer.disconnect();
    }
    const fit = () => {
      const styles = getComputedStyle(preview);
      const available =
        preview.clientWidth -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight);
      if (available <= 0) return;
      // Measure in CSS pixels so the surrounding table's zoom is independent.
      document.style.zoom = "1";
      document.style.width = `${available}px`;
      const width = Math.max(available, document.scrollWidth);
      document.style.width = `${width}px`;
      document.style.zoom = `${available / width}`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(preview);
    observer.observe(document);
    preview.addEventListener("load", fit, true);
    return () => {
      observer.disconnect();
      preview.removeEventListener("load", fit, true);
    };
  }, [markdown, raw]);
  return (
    <div
      ref={previewRef}
      className={`markdown-preview${conversation && !raw ? " conversation-preview" : ""}`}
      data-scroll-sync={conversation && !raw ? "chat" : undefined}
      role="region"
      aria-label={title}
      aria-busy={streaming}
      tabIndex={0}
      onScroll={({ currentTarget: preview }) => {
        if (raw !== "thinking") return;
        const top = preview.scrollTop;
        const atBottom = preview.scrollHeight - preview.clientHeight - top <= 2;
        // Appends and queued programmatic scroll events do not signal user intent.
        if (atBottom && top !== lastScrollTop.current) following.current = true;
        else if (!atBottom && top < lastScrollTop.current)
          following.current = false;
        lastScrollTop.current = top;
      }}
      onWheel={(event) => {
        if (
          raw === "thinking" &&
          event.deltaY < 0 &&
          event.currentTarget.scrollTop > 0
        )
          following.current = false;
      }}
    >
      {markdown === undefined && query.isPending && (
        <p role="status">Loading…</p>
      )}
      {query.error && (
        <>
          <ErrorMessage>{query.error.message}</ErrorMessage>
          <button className="secondary" onClick={() => void query.refetch()}>
            Retry preview
          </button>
        </>
      )}
      {markdown !== undefined && (
        <div className="markdown-document" ref={documentRef}>
          {raw ? (
            <pre
              className={`markdown-raw${raw === "thinking" ? " markdown-thinking" : ""}`}
            >
              {markdown}
            </pre>
          ) : conversation ? (
            <ChatConversation
              messages={
                !markdown && (streaming || query.data === undefined)
                  ? []
                  : readChatOutput(markdown)
              }
            />
          ) : (
            <MarkdownContent markdown={markdown} />
          )}
        </div>
      )}
    </div>
  );
}
