import { useState } from "react";
import type { ReferenceImage } from "../../server/image-settings";
import { ImageList, ImagePicker } from "./image-input";

export function PromptEditor({
  prompt,
  onPromptChange,
  attachments,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  attachments?: {
    images: readonly ReferenceImage[];
    onChange: (images: ReferenceImage[]) => void;
    onBusy: (busy: boolean) => void;
  };
}) {
  const [reading, setReading] = useState(false);
  return (
    <div className="prompt-editor" aria-busy={reading}>
      <div className="prompt-input">
        <textarea
          id="grid-prompt"
          aria-label="Prompt"
          rows={6}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="Describe what you want to generate"
        />
        {attachments && (
          <ImagePicker
            pasteTarget="grid-prompt"
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
        )}
      </div>
      {!!attachments?.images.length && (
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
    </div>
  );
}
