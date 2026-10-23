import { useId, useState } from "react";
import type { ReferenceImage } from "../../server/image-settings";
import { ImageList, ImagePicker } from "./image-input";
import { ValidationFeedback, ValidationField } from "./validation-feedback";
import { VariableTokenPicker } from "./variable-input";

export function PromptEditor({
  prompt,
  onPromptChange,
  attachments,
  variables,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  variables: readonly string[];
  attachments: {
    images: readonly ReferenceImage[];
    onChange: (images: ReferenceImage[]) => void;
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
                onRemove={(index) =>
                  attachments.onChange(
                    attachments.images.filter(
                      (_, imageIndex) => imageIndex !== index,
                    ),
                  )
                }
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
                onSelect={(selected) =>
                  attachments.onChange([...attachments.images, ...selected])
                }
              />
            </div>
            <VariableTokenPicker
              tokens={variables}
              targetId={`${id}-prompt`}
              value={prompt}
              onChange={onPromptChange}
              disabled={reading}
            />
          </div>
        )}
      </ValidationField>
      <ValidationFeedback />
    </>
  );
}
