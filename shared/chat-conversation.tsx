import type { FilledChatMessage } from "../server/domain.js";
import { MarkdownContent } from "./markdown.js";

export function ChatConversation({
  messages,
}: {
  messages: FilledChatMessage[];
}) {
  return (
    <ol className="chat-conversation">
      {messages.map((message, index) => (
        <li className="chat-message-row" key={index}>
          <div className="chat-bubble" data-role={message.role}>
            <MarkdownContent markdown={message.content} />
          </div>
        </li>
      ))}
    </ol>
  );
}
