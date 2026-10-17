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
        <li className="chat-bubble" data-role={message.role} key={index}>
          <MarkdownContent markdown={message.content} />
        </li>
      ))}
    </ol>
  );
}
