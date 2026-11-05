import type { ReactNode } from "react";
import {
  isChatFormat,
  type ChatMessage,
  type GridDraftInput,
} from "../../server/domain";
import type { AxisSide } from "../../server/parameters";
import type { InputAction, MessageEdit } from "./input-events";
import { ChatEditor } from "./chat-editor";
import { PromptEditor } from "./prompt-editor";

export function CompleteInputEditor(
  props: (
    | {
        source: "common";
      }
    | {
        source: AxisSide;
        caseIndex: number;
      }
  ) & {
    format: GridDraftInput["format"];
    messages: ChatMessage[];
    onAction: (action: InputAction) => void;
    onBusy: (busy: boolean) => void;
    compatibility: (messageIndex?: number) => ReactNode;
  },
) {
  const { format, messages, onAction, onBusy, compatibility } = props;
  function change(edit: MessageEdit) {
    onAction(
      props.source === "common"
        ? { type: "edit-input", source: "common", edit }
        : {
            type: "edit-input",
            source: props.source,
            caseIndex: props.caseIndex,
            edit,
          },
    );
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
