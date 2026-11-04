import type { ReactNode } from "react";
import {
  isChatFormat,
  type ChatMessage,
  type GridDraftInput,
} from "../../server/domain";
import type { AxisSide } from "../../server/parameters";
import type { InputAction, MessageEdit } from "./change-axis";
import { ChatEditor } from "./chat-editor";
import { PromptEditor } from "./prompt-editor";

export function CompleteInputEditor({
  format,
  messages,
  source,
  caseIndex,
  onAction,
  onBusy,
  compatibility,
}: {
  format: GridDraftInput["format"];
  messages: ChatMessage[];
  source: "common" | AxisSide;
  caseIndex?: number;
  onAction: (action: InputAction) => void;
  onBusy: (busy: boolean) => void;
  compatibility: (messageIndex?: number) => ReactNode;
}) {
  function change(edit: MessageEdit) {
    onAction({
      type: "edit-input",
      source,
      ...(caseIndex === undefined ? {} : { caseIndex }),
      edit,
    });
  }
  if (isChatFormat(format))
    return (
      <ChatEditor
        messages={messages}
        onChange={change}
        onBusy={onBusy}
        compatibility={compatibility}
      />
    );
  return (
    <>
      <PromptEditor
        prompt={messages[0]?.content ?? ""}
        onPromptChange={(content) =>
          change({ type: "prompt-content", content })
        }
        attachments={{
          images: messages[0]?.images ?? [],
          onBusy,
          onAppend: (images) =>
            change({ type: "prompt-append-images", images }),
          onRemove: (imageIndex) =>
            change({ type: "prompt-remove-image", imageIndex }),
        }}
      />
      {compatibility()}
    </>
  );
}
