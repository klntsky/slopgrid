import type { FilledChatMessage } from "../server/domain.js";
import type { ReferenceImage } from "../server/image-settings.js";
import { MarkdownContent } from "./markdown.js";

export function ChatConversation({
  messages,
  imageSource = (image) => `/api/references/${encodeURIComponent(image.id)}`,
}: {
  messages: FilledChatMessage[];
  imageSource?: (image: ReferenceImage) => string;
}) {
  return (
    <ol className="chat-conversation" data-scroll-sync-items="">
      {messages.map((message, index) => (
        <li className="chat-message-row" key={index}>
          <div className="chat-bubble" data-role={message.role}>
            {message.role === "user" && !!message.images?.length && (
              <div className="chat-message-images">
                {message.images.map((image, imageIndex) => (
                  <img
                    key={`${image.id}-${imageIndex}`}
                    src={imageSource(image)}
                    alt={image.name}
                  />
                ))}
              </div>
            )}
            {message.content && <MarkdownContent markdown={message.content} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
