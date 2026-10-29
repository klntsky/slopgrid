import { useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  ChatImage as ChatImageAttachment,
  FilledChatMessage,
} from "../server/domain.js";
import { MarkdownContent } from "./markdown.js";

function ChatImage({
  image,
  src,
  showImageLoader,
}: {
  image: ChatImageAttachment;
  src: string;
  showImageLoader: boolean;
}) {
  const element = useRef<HTMLImageElement>(null);
  const [loading, setLoading] = useState(true);
  useLayoutEffect(() => {
    // Cached images can finish before React attaches the load/error handlers.
    if (element.current?.complete) setLoading(false);
  }, []);
  const { width, height } = image;
  return (
    <div
      className="chat-image-frame"
      aria-busy={showImageLoader && loading}
      style={{
        width: width * Math.min(1, 320 / height),
        aspectRatio: `${width} / ${height}`,
      }}
    >
      <img
        ref={element}
        src={src}
        alt={image.name}
        width={width}
        height={height}
        onLoad={() => setLoading(false)}
        onError={() => setLoading(false)}
      />
      {showImageLoader && loading && (
        <div
          className="chat-image-loader"
          role="progressbar"
          aria-label={image.name}
        >
          <LoaderCircle className="spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export function ChatConversation({
  messages,
  showImageLoader = true,
}: {
  messages: FilledChatMessage[];
  showImageLoader?: boolean;
}) {
  return (
    <ol className="chat-conversation" data-scroll-sync-items="">
      {messages.map((message, index) => (
        <li className="chat-message-row" key={index}>
          <div className="chat-bubble" data-role={message.role}>
            {!!message.images?.length && (
              <div className="chat-message-images">
                {message.images.map((image, imageIndex) => {
                  const src = image.dataUrl;
                  return (
                    <ChatImage
                      key={`${imageIndex}-${src}`}
                      image={image}
                      src={src}
                      showImageLoader={showImageLoader}
                    />
                  );
                })}
              </div>
            )}
            {message.content && <MarkdownContent markdown={message.content} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
