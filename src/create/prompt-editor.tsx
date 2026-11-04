import { useId, useState } from "react";
import type { ReferenceImage } from "../../server/image-settings";
import { ImageList, ImagePicker } from "./image-input";
import { ValidationFeedback, ValidationField } from "./validation-feedback";

export function PromptEditor({
  prompt,
  onPromptChange,
  attachments,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  attachments: {
    images: readonly ReferenceImage[];
    onAppend: (images: ReferenceImage[]) => void;
    onRemove: (index: number) => void;
    onBusy: (busy: boolean) => void;
  };
}) {
  const [reading, setReading] = useState(false);
  const id = useId();
  return (
    <>
      <ValidationField path={[0]}>
        {(validation) => (
          <div className="prompt-editor" aria-busy={reading}>
            {!!attachments.images.length && (
              <ImageList
                images={attachments.images}
                disabled={reading}
                removeLabel={(image) => `Remove ${image.name} from prompt`}
                onRemove={attachments.onRemove}
              />
            )}
            <div className="prompt-input">
              <textarea
                id={`${id}-prompt`}
                aria-label="Prompt"
                {...validation}
                rows={6}
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder="Describe what you want to generate"
              />
              <ImagePicker
                pasteTarget={`${id}-prompt`}
                accessibleLabel="Add images to prompt"
                disabled={reading}
                onBusy={(busy) => {
                  setReading(busy);
                  attachments.onBusy(busy);
                }}
                onSelect={attachments.onAppend}
              />
            </div>
          </div>
        )}
      </ValidationField>
      <ValidationFeedback />
    </>
  );
}
