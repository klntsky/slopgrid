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
  const hasDimensions =
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0;
  return (
    <div
      className="chat-image-frame"
      aria-busy={showImageLoader && loading}
      style={{
        width: hasDimensions ? width * Math.min(1, 320 / height) : 320,
        aspectRatio: hasDimensions ? `${width} / ${height}` : "4 / 3",
      }}
    >
      <img
        ref={element}
        src={src}
        alt={image.name}
        width={hasDimensions ? width : undefined}
        height={hasDimensions ? height : undefined}
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
  imageSource = (image) =>
    "kind" in image
      ? image.dataUrl
      : `/api/references/${encodeURIComponent(image.id)}`,
  showImageLoader = true,
}: {
  messages: FilledChatMessage[];
  imageSource?: (image: ChatImageAttachment) => string;
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
                  const src = imageSource(image);
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
